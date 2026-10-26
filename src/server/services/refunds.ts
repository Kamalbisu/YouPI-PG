import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { db, type Tx } from "@/lib/db";
import { AppError, badRequest, conflict, notFound } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { randomCode, dateStamp, withUniqueCode } from "@/lib/ids";
import { formatMinorPlain } from "@/lib/money";
import { pageQuery, skipTake, toPage, type Page } from "@/lib/pagination";
import { enforceRateLimit } from "@/lib/rate-limit";
import { amountMinorSchema, parse } from "@/lib/validation";
import { businessScope, requireActor, requireClient } from "@/server/auth/guards";
import type { Ctx } from "@/server/auth/types";
import { credentialsForAttempt } from "@/server/payments/credentials";
import { getProvider, type NormalizedRefund, type ProviderId } from "@/server/payments";
import { notify, notifyBusinessUsers } from "./notifications";

const refundInput = z.object({
  transactionId: z.string().trim().min(1).max(64),
  amountMinor: amountMinorSchema,
  reason: z.string().trim().min(3, "Enter a reason").max(300),
  idempotencyKey: z.string().trim().min(8).max(100),
});

export interface RefundView {
  id: string;
  refundRef: string;
  transactionId: string;
  orderId: string;
  amountMinor: number;
  reason: string | null;
  status: "PENDING" | "PROCESSED" | "FAILED";
  failureReason: string | null;
  createdAt: string;
  processedAt: string | null;
  replayed?: boolean;
}

const view = (r: { id: string; refundRef: string; transactionId: string; orderId: string; amountMinor: number; reason: string | null; status: RefundView["status"]; failureReason: string | null; createdAt: Date; processedAt: Date | null }): RefundView => ({
  id: r.id,
  refundRef: r.refundRef,
  transactionId: r.transactionId,
  orderId: r.orderId,
  amountMinor: r.amountMinor,
  reason: r.reason,
  status: r.status,
  failureReason: r.failureReason,
  createdAt: r.createdAt.toISOString(),
  processedAt: r.processedAt?.toISOString() ?? null,
});

async function lockTxn(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT "id" FROM "payment_transactions" WHERE "id" = ${id} FOR UPDATE`;
}

/** Amount still available to refund: amount minus processed refunds minus refunds in flight. Call with the txn row locked. */
async function refundable(tx: Tx, transactionId: string): Promise<{ refundable: number; amountMinor: number }> {
  const t = await tx.paymentTransaction.findUniqueOrThrow({ where: { id: transactionId }, select: { amountMinor: true, refundedMinor: true } });
  const pending = await tx.refund.aggregate({ where: { transactionId, status: "PENDING" }, _sum: { amountMinor: true } });
  return { refundable: t.amountMinor - t.refundedMinor - (pending._sum.amountMinor ?? 0), amountMinor: t.amountMinor };
}

/**
 * Moves a refund to a terminal status. Idempotent and monotonic: only PENDING refunds change, so a replayed
 * or out-of-order webhook can neither double count nor downgrade a PROCESSED refund. Call inside a transaction.
 * Transaction and order become (PARTIALLY_)REFUNDED only when a refund is PROCESSED.
 */
async function settleRefund(
  ctx: Ctx,
  tx: Tx,
  refundId: string,
  next: { status: "PROCESSED" | "FAILED" | "PENDING"; providerRefundId?: string | null; failureReason?: string | null },
): Promise<{ changed: boolean; becameProcessed: boolean }> {
  const existing = await tx.refund.findUniqueOrThrow({ where: { id: refundId }, include: { transaction: { include: { order: { include: { business: { select: { clientId: true } } } } } } } });
  await lockTxn(tx, existing.transactionId);
  const r = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
  const data: Prisma.RefundUpdateInput = {};
  if (next.providerRefundId && !r.providerRefundId) data.providerRefundId = next.providerRefundId;
  if (r.status !== "PENDING" || next.status === "PENDING") {
    if (Object.keys(data).length) await tx.refund.update({ where: { id: r.id }, data });
    return { changed: false, becameProcessed: false };
  }
  const txn = existing.transaction;
  if (next.status === "FAILED") {
    await tx.refund.update({ where: { id: r.id }, data: { ...data, status: "FAILED", failureReason: (next.failureReason ?? "Refund failed").slice(0, 300) } });
    await audit(ctx, { action: "refund.failed", entityType: "Refund", entityId: r.id, clientId: txn.order.business.clientId, metadata: { refundRef: r.refundRef, txnRef: txn.txnRef, amountMinor: r.amountMinor } }, tx);
    return { changed: true, becameProcessed: false };
  }
  // PROCESSED
  const t = await tx.paymentTransaction.findUniqueOrThrow({ where: { id: txn.id } });
  const refunded = Math.min(t.amountMinor, t.refundedMinor + r.amountMinor);
  const full = refunded >= t.amountMinor;
  await tx.refund.update({ where: { id: r.id }, data: { ...data, status: "PROCESSED", processedAt: new Date(), failureReason: null } });
  await tx.paymentTransaction.update({ where: { id: t.id }, data: { refundedMinor: refunded, status: full ? "REFUNDED" : "PARTIALLY_REFUNDED" } });
  // A duplicate payment is not the order's payment: refunding it leaves the order untouched.
  if (!t.isDuplicate && ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(txn.order.status)) {
    await tx.order.update({ where: { id: txn.orderId }, data: { status: full ? "REFUNDED" : "PARTIALLY_REFUNDED" } });
  }
  await audit(ctx, { action: "refund.processed", entityType: "Refund", entityId: r.id, clientId: txn.order.business.clientId, metadata: { refundRef: r.refundRef, txnRef: txn.txnRef, amountMinor: r.amountMinor, fullyRefunded: full } }, tx);
  return { changed: true, becameProcessed: true };
}

async function notifyRefunded(refundId: string) {
  const r = await db.refund.findUnique({ where: { id: refundId }, include: { transaction: true, order: { include: { business: { select: { id: true } } } } } });
  if (!r) return;
  const amount = formatMinorPlain(r.amountMinor);
  if (r.order.customerEmail) {
    await notify({
      to: r.order.customerEmail,
      type: "refund.processed",
      subject: `Refund of ${amount} for order ${r.order.orderCode}`,
      body: `A refund of ${amount} was issued for order ${r.order.orderCode}. Refund reference: ${r.refundRef}. It can take a few business days to appear on your statement.`,
    });
  }
  await notifyBusinessUsers(r.order.business.id, {
    type: "refund.processed",
    subject: `Refund processed: ${amount}`,
    body: `Order ${r.order.orderCode}: refund ${r.refundRef} of ${amount} was processed.`,
    link: `${env().APP_URL}/client/transactions/${r.transactionId}`,
  });
}

/**
 * Requests a refund. Admin, or an owner with payments.refund (managers are refused by requireClient).
 *
 * Concurrency: the transaction row is locked while the refundable amount is computed and a PENDING refund row
 * is inserted, so concurrent requests serialise and the sum of PENDING + PROCESSED refunds can never exceed the
 * paid amount. The provider call happens after that lock is released.
 */
export async function requestRefund(ctx: Ctx, input: unknown): Promise<RefundView> {
  const actor = requireActor(ctx);
  if (actor.role === "CLIENT") requireClient(ctx, "payments.refund");
  const data = parse(refundInput, input);
  if (actor.role === "CLIENT") await enforceRateLimit(`refund:user:${actor.userId}`, 30, 3600);

  const txn = await db.paymentTransaction.findUnique({
    where: { id: data.transactionId },
    include: { attempt: { select: { configId: true } }, order: { include: { business: { select: { id: true, clientId: true } } } } },
  });
  if (!txn) throw notFound("Transaction");
  if (actor.role === "CLIENT" && (!actor.businessIds.includes(txn.order.businessId) || txn.order.business.clientId !== actor.clientId)) throw notFound("Transaction");
  const clientId = txn.order.business.clientId;
  // Scoped per transaction so a key chosen by one tenant can never collide with or reveal another's.
  const key = `${txn.id}:${data.idempotencyKey}`;

  const prepared = await db.$transaction(async (tx) => {
    await lockTxn(tx, txn.id);
    const prior = await tx.refund.findUnique({ where: { idempotencyKey: key } });
    if (prior) {
      if (prior.amountMinor !== data.amountMinor) throw conflict("This idempotency key was already used with a different amount");
      return { refund: prior, replayed: true };
    }
    const t = await tx.paymentTransaction.findUniqueOrThrow({ where: { id: txn.id } });
    if (t.status === "REFUNDED") throw conflict("This transaction is already fully refunded");
    const room = await refundable(tx, txn.id);
    if (data.amountMinor > room.refundable) {
      throw badRequest(room.refundable > 0 ? `Refund exceeds the refundable amount of ${formatMinorPlain(room.refundable)}` : "Nothing left to refund on this transaction", { refundableMinor: Math.max(0, room.refundable) });
    }
    const refund = await withUniqueCode(
      () => randomCode(`RFD-${dateStamp()}`, 6),
      (refundRef) =>
        tx.refund.create({
          data: { refundRef, transactionId: txn.id, orderId: txn.orderId, amountMinor: data.amountMinor, reason: data.reason, status: "PENDING", idempotencyKey: key, requestedById: actor.userId },
        }),
    );
    await audit(ctx, { action: "refund.request", entityType: "Refund", entityId: refund.id, clientId, metadata: { refundRef: refund.refundRef, txnRef: txn.txnRef, amountMinor: data.amountMinor, reason: data.reason } }, tx);
    return { refund, replayed: false };
  });

  if (prepared.replayed) return { ...view(prepared.refund), replayed: true };

  // Provider call outside the row lock.
  let result: NormalizedRefund | null = null;
  let failure: AppError | null = null;
  try {
    const creds = await credentialsForAttempt(txn.provider, txn.attempt.configId);
    result = await getProvider(txn.provider).createRefund(creds, {
      providerPaymentId: txn.providerPaymentId,
      providerOrderId: (await db.paymentAttempt.findUnique({ where: { id: txn.attemptId }, select: { providerOrderId: true } }))?.providerOrderId ?? null,
      amountMinor: data.amountMinor,
      refundRef: prepared.refund.refundRef,
      reason: data.reason,
    });
  } catch (e) {
    failure = e instanceof AppError ? e : new AppError("PROVIDER_UNAVAILABLE", "The payment provider could not process the refund");
  }

  let becameProcessed = false;
  await db.$transaction(async (tx) => {
    if (failure) {
      await settleRefund(ctx, tx, prepared.refund.id, { status: "FAILED", failureReason: failure.message });
      return;
    }
    const r = await settleRefund(ctx, tx, prepared.refund.id, { status: result!.status, providerRefundId: result!.providerRefundId, failureReason: result!.failureReason });
    becameProcessed = r.becameProcessed;
  });
  if (becameProcessed) await notifyRefunded(prepared.refund.id).catch(() => undefined);

  const fresh = await db.refund.findUniqueOrThrow({ where: { id: prepared.refund.id } });
  if (failure) throw new AppError(failure.code, failure.message, { refundRef: fresh.refundRef, status: fresh.status });
  return view(fresh);
}

/**
 * Applies a verified provider refund event (webhook). Matches by our refundRef, then by provider refund id.
 * A refund created directly in the provider dashboard is recorded against its payment so totals stay true.
 */
export async function applyRefundEvent(
  ctx: Ctx,
  input: { provider: ProviderId; refund: NormalizedRefund; expectConfigId?: string | null },
): Promise<{ matched: boolean; note?: string }> {
  const { provider, refund } = input;
  let row = null as Awaited<ReturnType<typeof findRefund>>;
  row = await findRefund(provider, refund);
  if (row && input.expectConfigId !== undefined && row.transaction.attempt.configId !== input.expectConfigId) return { matched: false, note: "Refund belongs to a different payment configuration" };

  if (!row) {
    if (!refund.providerPaymentId) return { matched: false, note: "Refund event does not reference a known payment" };
    const txn = await db.paymentTransaction.findUnique({ where: { provider_providerPaymentId: { provider, providerPaymentId: refund.providerPaymentId } }, include: { attempt: { select: { configId: true } } } });
    if (!txn) return { matched: false, note: "No transaction for this refund's payment" };
    if (input.expectConfigId !== undefined && txn.attempt.configId !== input.expectConfigId) return { matched: false, note: "Refund belongs to a different payment configuration" };
    let note: string | undefined;
    const created = await db.$transaction(async (tx) => {
      await lockTxn(tx, txn.id);
      const dup = await tx.refund.findUnique({ where: { idempotencyKey: `ext:${provider}:${refund.providerRefundId}` } });
      if (dup) return dup;
      const room = await refundable(tx, txn.id);
      if (refund.amountMinor <= 0 || refund.amountMinor > room.refundable) {
        note = "External refund exceeds the refundable amount and was not recorded";
        return null;
      }
      return withUniqueCode(
        () => randomCode(`RFD-${dateStamp()}`, 6),
        (refundRef) =>
          tx.refund.create({
            data: { refundRef, transactionId: txn.id, orderId: txn.orderId, amountMinor: refund.amountMinor, reason: "Created at the payment provider", status: "PENDING", providerRefundId: refund.providerRefundId, idempotencyKey: `ext:${provider}:${refund.providerRefundId}` },
          }),
      );
    });
    if (!created) return { matched: false, note };
    row = await findRefund(provider, { ...refund, refundRef: created.refundRef });
    if (!row) return { matched: false, note: "Refund could not be recorded" };
  }

  const target = row;
  const res = await db.$transaction((tx) => settleRefund(ctx, tx, target.id, { status: refund.status, providerRefundId: refund.providerRefundId, failureReason: refund.failureReason }));
  if (res.becameProcessed) await notifyRefunded(target.id).catch(() => undefined);
  return { matched: true };
}

async function findRefund(provider: ProviderId, refund: NormalizedRefund) {
  const include = { transaction: { include: { attempt: { select: { configId: true } } } } } as const;
  if (refund.refundRef) {
    const byRef = await db.refund.findUnique({ where: { refundRef: refund.refundRef }, include });
    if (byRef && byRef.transaction.provider === provider) return byRef;
  }
  return db.refund.findFirst({ where: { providerRefundId: refund.providerRefundId, transaction: { provider } }, include });
}

// ---------------------------------------------------------------------------------------------
// Listing

const listQuery = pageQuery.extend({
  status: z.enum(["PENDING", "PROCESSED", "FAILED"]).optional(),
  businessId: z.string().trim().max(64).optional(),
  clientId: z.string().trim().max(64).optional(),
});

export interface RefundListRow extends RefundView {
  orderCode: string;
  txnRef: string;
  businessName: string;
}

/** Admin: all refunds. Client (payments.view): refunds of their own businesses only. */
export async function listRefunds(ctx: Ctx, input: unknown): Promise<Page<RefundListRow>> {
  const actor = requireActor(ctx);
  if (actor.role === "CLIENT") requireClient(ctx, "payments.view");
  const q = parse(listQuery, input ?? {});
  const scope = businessScope(ctx);
  const where: Prisma.RefundWhereInput = {
    ...(q.status ? { status: q.status } : {}),
    order: {
      ...(scope ? { businessId: scope } : {}),
      ...(q.businessId ? { businessId: scope ? { in: scope.in.filter((id) => id === q.businessId) } : q.businessId } : {}),
      ...(actor.role === "SUPER_ADMIN" && q.clientId ? { business: { clientId: q.clientId } } : {}),
    },
    ...(q.q ? { OR: [{ refundRef: { contains: q.q, mode: "insensitive" } }, { order: { orderCode: { contains: q.q, mode: "insensitive" } } }, { transaction: { txnRef: { contains: q.q, mode: "insensitive" } } }] } : {}),
  };
  const [items, total] = await Promise.all([
    db.refund.findMany({ where, orderBy: { createdAt: "desc" }, ...skipTake(q), include: { order: { select: { orderCode: true, business: { select: { name: true } } } }, transaction: { select: { txnRef: true } } } }),
    db.refund.count({ where }),
  ]);
  return toPage(
    items.map((r) => ({ ...view(r), orderCode: r.order.orderCode, txnRef: r.transaction.txnRef, businessName: r.order.business.name })),
    total,
    q,
  );
}
