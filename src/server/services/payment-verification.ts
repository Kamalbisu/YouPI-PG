import { z } from "zod";
import type { PaymentAttempt, Prisma } from "@/generated/prisma/client";
import { db, type Tx } from "@/lib/db";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { randomCode, dateStamp, withUniqueCode } from "@/lib/ids";
import { formatMinorPlain } from "@/lib/money";
import { parse } from "@/lib/validation";
import { systemCtx, type Ctx } from "@/server/auth/types";
import { credentialsForAttempt } from "@/server/payments/credentials";
import { getProvider, type NormalizedPayment, type ProviderId } from "@/server/payments";
import { notify, notifyAdmins, notifyBusinessUsers } from "./notifications";

export type VerificationSource = "WEBHOOK" | "API_FETCH" | "CHECKOUT_SIGNATURE";

export type PaymentOutcome =
  | "PAID" // first verified payment: order is now PAID
  | "LATE_PAID" // verified payment on an EXPIRED order: order is PAID and flagged for reconciliation
  | "DUPLICATE" // verified payment on an already paid / cancelled order: stored with isDuplicate
  | "ALREADY_RECORDED" // the same provider payment was already processed (idempotent replay)
  | "MISMATCH" // amount or currency differs: not paid, attempt failed, flagged
  | "FAILED"
  | "CANCELLED"
  | "PENDING"
  | "UNMATCHED"; // no attempt of ours corresponds to this provider order

export interface PaymentResult {
  outcome: PaymentOutcome;
  orderId?: string;
  attemptId?: string;
  transactionId?: string;
}

const OPEN = ["CREATED", "PENDING", "AUTHORIZED"] as const;
const isOpen = (s: string) => (OPEN as readonly string[]).includes(s);

async function lockOrder(tx: Tx, orderId: string) {
  const rows = await tx.$queryRaw<{ id: string; status: string }[]>`SELECT "id", "status" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE`;
  return rows[0] ?? null;
}

async function setAttempt(tx: Tx, at: PaymentAttempt, status: PaymentAttempt["status"], source: string, note: string | null, extra: Prisma.PaymentAttemptUpdateInput = {}) {
  await tx.paymentAttempt.update({ where: { id: at.id }, data: { status, ...extra } });
  await tx.paymentStatusHistory.create({ data: { attemptId: at.id, fromStatus: at.status, toStatus: status, source, note } });
}

/**
 * THE single choke point where a provider payment becomes (or does not become) money received.
 * Webhooks, the Razorpay checkout-return signature and server-side polling all call this.
 * Never call it with unverified data: callers must have verified a signature or fetched the payment from
 * the provider over an authenticated channel.
 *
 * Runs in one transaction with the order row locked, so concurrent deliveries serialise. It is idempotent
 * on (provider, providerPaymentId).
 */
export async function applyPaymentEvent(
  ctx: Ctx,
  input: { provider: ProviderId; payment: NormalizedPayment; source: VerificationSource; attemptId?: string; expectConfigId?: string | null },
): Promise<PaymentResult> {
  const { provider, payment, source } = input;

  // Locate the attempt: explicit id, else the provider order id, else a known provider payment id.
  let attempt: PaymentAttempt | null = null;
  if (input.attemptId) attempt = await db.paymentAttempt.findUnique({ where: { id: input.attemptId } });
  if (!attempt && payment.providerOrderId) {
    attempt = await db.paymentAttempt.findUnique({ where: { provider_providerOrderId: { provider, providerOrderId: payment.providerOrderId } } });
  }
  if (!attempt) {
    attempt = await db.paymentAttempt.findFirst({ where: { provider, providerPaymentId: payment.providerPaymentId } });
  }
  if (!attempt || attempt.provider !== provider) return { outcome: "UNMATCHED" };
  // A per-business webhook URL may only affect attempts created with that business configuration.
  if (input.expectConfigId !== undefined && attempt.configId !== input.expectConfigId) return { outcome: "UNMATCHED" };
  const attemptId = attempt.id;
  const orderId = attempt.orderId;

  const result = await db.$transaction(async (tx): Promise<PaymentResult & { notifyPaid?: boolean; flag?: "LATE" | "DUPLICATE" | "MISMATCH" }> => {
    const order = await lockOrder(tx, orderId);
    if (!order) return { outcome: "UNMATCHED" };
    const at = await tx.paymentAttempt.findUniqueOrThrow({ where: { id: attemptId } });

    if (payment.status === "PENDING") {
      if (at.status === "CREATED") {
        await setAttempt(tx, at, "PENDING", source, "Payment is processing", { providerPaymentId: payment.providerPaymentId, method: payment.method ?? at.method });
      }
      return { outcome: "PENDING", orderId, attemptId };
    }

    if (payment.status === "FAILED" || payment.status === "CANCELLED") {
      // A failure never overrides a success, and never touches the order.
      if (isOpen(at.status)) {
        const to = payment.status === "FAILED" ? "FAILED" : "CANCELLED";
        await setAttempt(tx, at, to, source, payment.failureReason ?? null, {
          providerPaymentId: payment.providerPaymentId,
          failureReason: payment.failureReason ?? (to === "CANCELLED" ? "Cancelled by customer" : "Payment failed"),
        });
      }
      return { outcome: payment.status, orderId, attemptId };
    }

    // ---- SUCCEEDED ----
    const already = await tx.paymentTransaction.findUnique({ where: { provider_providerPaymentId: { provider, providerPaymentId: payment.providerPaymentId } } });
    if (already) return { outcome: "ALREADY_RECORDED", orderId, attemptId: already.attemptId, transactionId: already.id };

    const orderRow = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true, business: { select: { clientId: true } } } });

    if (payment.amountMinor !== at.amountMinor || payment.currency.toUpperCase() !== at.currency.toUpperCase() || at.amountMinor !== orderRow.totalMinor) {
      const reason = `Amount mismatch: provider reported ${payment.currency} ${payment.amountMinor}, expected ${at.currency} ${at.amountMinor}`;
      const replay = at.status === "FAILED" && at.providerPaymentId === payment.providerPaymentId && at.failureReason?.startsWith("Amount mismatch");
      if (!replay) {
        if (isOpen(at.status) || at.status === "CANCELLED") {
          await setAttempt(tx, at, "FAILED", source, `MISMATCH: ${reason}`, { providerPaymentId: payment.providerPaymentId, failureReason: reason });
        } else {
          await tx.paymentStatusHistory.create({ data: { attemptId: at.id, fromStatus: at.status, toStatus: at.status, source, note: `MISMATCH: ${reason}` } });
        }
        await audit(
          ctx,
          { action: "payment.mismatch", entityType: "PaymentAttempt", entityId: at.id, clientId: orderRow.business.clientId, metadata: { orderId, provider, providerPaymentId: payment.providerPaymentId, expectedMinor: at.amountMinor, reportedMinor: payment.amountMinor, source } },
          tx,
        );
      }
      return { outcome: "MISMATCH", orderId, attemptId, flag: replay ? undefined : "MISMATCH" };
    }

    // The attempt can carry only one transaction (attemptId is unique). A second distinct payment against an
    // attempt that already has one is recorded on a synthetic attempt so it can be reconciled and refunded.
    let useAttempt = at;
    const attemptTaken = await tx.paymentTransaction.findUnique({ where: { attemptId: at.id }, select: { id: true } });
    if (attemptTaken) {
      useAttempt = await tx.paymentAttempt.create({
        data: {
          orderId,
          configId: at.configId,
          provider,
          method: payment.method ?? at.method,
          status: "SUCCEEDED",
          amountMinor: payment.amountMinor,
          currency: payment.currency,
          idempotencyKey: `dup:${provider}:${payment.providerPaymentId}`,
          providerPaymentId: payment.providerPaymentId,
          expiresAt: at.expiresAt,
        },
      });
      await tx.paymentStatusHistory.create({ data: { attemptId: useAttempt.id, fromStatus: null, toStatus: "SUCCEEDED", source, note: "DUPLICATE: second payment received for this order" } });
    }

    const firstPayment = order.status === "PENDING_PAYMENT" || order.status === "EXPIRED";
    const isDuplicate = !firstPayment;
    const late = order.status === "EXPIRED";
    const now = new Date();

    const txn = await withUniqueCode(
      () => randomCode(`TXN-${dateStamp()}`, 6),
      (txnRef) =>
        tx.paymentTransaction.create({
          data: {
            txnRef,
            orderId,
            attemptId: useAttempt.id,
            provider,
            providerPaymentId: payment.providerPaymentId,
            method: payment.method ?? useAttempt.method ?? null,
            status: "SUCCEEDED",
            amountMinor: payment.amountMinor,
            currency: payment.currency,
            feeMinor: payment.feeMinor ?? null,
            feeTaxMinor: payment.feeTaxMinor ?? null,
            isDuplicate,
            verificationSource: source,
            verifiedAt: now,
          },
        }),
    );

    if (!attemptTaken) {
      await setAttempt(tx, at, "SUCCEEDED", source, isDuplicate ? "DUPLICATE: order was already settled" : late ? "LATE_PAYMENT: order had expired" : "Payment verified", {
        providerPaymentId: payment.providerPaymentId,
        method: payment.method ?? at.method,
        failureReason: null,
      });
    } else if (late) {
      await tx.paymentStatusHistory.create({ data: { attemptId: useAttempt.id, fromStatus: "SUCCEEDED", toStatus: "SUCCEEDED", source, note: "LATE_PAYMENT: order had expired" } });
    }

    if (!isDuplicate) {
      await tx.order.update({ where: { id: orderId }, data: { status: "PAID", paidAt: now } });
      // Stock is decremented at verification time (not at order creation) so abandoned carts never hold stock.
      // The update is guarded: it can never take stock below zero (a late/oversold payment is still honoured).
      for (const it of orderRow.items) {
        if (!it.productId) continue;
        await tx.$executeRaw`UPDATE "products" SET "stockQty" = GREATEST("stockQty" - ${it.quantity}, 0) WHERE "id" = ${it.productId} AND "trackInventory" = true`;
      }
      // Coupon usage is counted only for a verified payment.
      if (orderRow.offerId) await tx.$executeRaw`UPDATE "offers" SET "usedCount" = "usedCount" + 1 WHERE "id" = ${orderRow.offerId}`;
    } else if (order.status === "CANCELLED") {
      await tx.paymentStatusHistory.create({ data: { attemptId: useAttempt.id, fromStatus: "SUCCEEDED", toStatus: "SUCCEEDED", source, note: "DUPLICATE: payment received for a cancelled order, refund needed" } });
    }

    // Any other open attempt on a now-paid order is no longer needed.
    if (!isDuplicate) {
      const others = await tx.paymentAttempt.findMany({ where: { orderId, id: { not: useAttempt.id }, status: { in: [...OPEN] } } });
      for (const o of others) await setAttempt(tx, o, "CANCELLED", "SYSTEM", "Order was paid by another attempt", { failureReason: "Order was paid" });
    }

    await audit(
      ctx,
      {
        action: isDuplicate ? "payment.duplicate" : late ? "payment.late" : "payment.verified",
        entityType: "PaymentTransaction",
        entityId: txn.id,
        clientId: orderRow.business.clientId,
        metadata: { txnRef: txn.txnRef, orderId, orderCode: orderRow.orderCode, provider, source, amountMinor: txn.amountMinor, isDuplicate, late },
      },
      tx,
    );

    return {
      outcome: isDuplicate ? "DUPLICATE" : late ? "LATE_PAID" : "PAID",
      orderId,
      attemptId: useAttempt.id,
      transactionId: txn.id,
      notifyPaid: !isDuplicate,
      flag: isDuplicate ? "DUPLICATE" : late ? "LATE" : undefined,
    };
  });

  // Notifications only after the transaction committed and only for verified payments. They never throw.
  if (result.outcome === "PAID" || result.outcome === "LATE_PAID") await notifyPaid(result.orderId!, result.transactionId!).catch(() => undefined);
  if (result.flag === "DUPLICATE" || result.flag === "LATE" || result.flag === "MISMATCH") {
    await notifyAdmins({
      type: `payment.${result.flag.toLowerCase()}`,
      subject: result.flag === "DUPLICATE" ? "Duplicate payment needs a refund" : result.flag === "LATE" ? "Late payment received" : "Payment amount mismatch",
      body: `A payment needs review in Reconciliation (order ${result.orderId}).`,
      link: `${env().APP_URL}/admin/payments`,
    }).catch(() => undefined);
  }
  return result;
}

async function notifyPaid(orderId: string, transactionId: string) {
  const o = await db.order.findUnique({ where: { id: orderId }, include: { business: { select: { id: true, name: true } } } });
  const t = await db.paymentTransaction.findUnique({ where: { id: transactionId } });
  if (!o || !t) return;
  const amount = formatMinorPlain(t.amountMinor);
  if (o.customerEmail) {
    await notify({
      to: o.customerEmail,
      type: "payment.receipt",
      subject: `Payment received for order ${o.orderCode}`,
      body: `Thank you. We received ${amount} for order ${o.orderCode} at ${o.business.name}.\nTransaction reference: ${t.txnRef}`,
      link: `${env().APP_URL}/pay/${o.publicId}`,
    });
  }
  await notifyBusinessUsers(o.business.id, {
    type: "payment.received",
    subject: `Payment received: ${amount}`,
    body: `Order ${o.orderCode} was paid (${amount}). Transaction reference: ${t.txnRef}`,
    link: `${env().APP_URL}/client/transactions`,
  });
}

// ---------------------------------------------------------------------------------------------
// Public status read model + polling

export type PaymentState = "NONE" | "IN_PROGRESS" | "PENDING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "EXPIRED";

export interface PaymentStatusView {
  publicId: string;
  orderCode: string;
  orderStatus: string;
  /** Customer facing state for the result pages. SUCCEEDED means verified by the backend. */
  paymentState: PaymentState;
  /** Present only after the backend verified the payment. */
  txnRef: string | null;
  attemptId: string | null;
  failureReason: string | null;
  expiresAt: string;
}

export async function getPaymentStatus(publicId: string): Promise<PaymentStatusView> {
  const o = await db.order.findUnique({
    where: { publicId },
    include: {
      attempts: { orderBy: { createdAt: "desc" }, take: 1 },
      transactions: { where: { isDuplicate: false }, orderBy: { verifiedAt: "asc" }, take: 1, select: { txnRef: true } },
    },
  });
  if (!o) throw notFound("Order");
  const last = o.attempts[0] ?? null;
  const txn = o.transactions[0] ?? null;
  let state: PaymentState;
  if (o.status === "PAID" || o.status === "PARTIALLY_REFUNDED" || o.status === "REFUNDED") state = "SUCCEEDED";
  else if (o.status === "CANCELLED") state = "CANCELLED";
  else if (o.status === "EXPIRED" || o.expiresAt.getTime() <= Date.now()) state = "EXPIRED";
  else if (!last) state = "NONE";
  else if (last.status === "FAILED") state = "FAILED";
  else if (last.status === "CANCELLED") state = "CANCELLED";
  else if (last.status === "CREATED") state = "IN_PROGRESS";
  else state = "PENDING";
  return {
    publicId: o.publicId,
    orderCode: o.orderCode,
    orderStatus: o.status,
    paymentState: state,
    txnRef: state === "SUCCEEDED" ? (txn?.txnRef ?? null) : null,
    attemptId: last?.id ?? null,
    failureReason: state === "FAILED" ? (last?.failureReason ?? null) : null,
    expiresAt: o.expiresAt.toISOString(),
  };
}

/**
 * Server-side verification by polling: asks the provider (authenticated) what happened to the order's
 * attempts and funnels any result through applyPaymentEvent. Used by the result page poller and by the
 * reconciliation "refetch" action. A provider outage does not throw; it leaves the state unchanged.
 */
export async function refreshPaymentStatus(publicId: string, ctx: Ctx = systemCtx()): Promise<PaymentStatusView> {
  const id = parse(z.string().trim().min(8).max(100), publicId);
  const order = await db.order.findUnique({ where: { publicId: id }, select: { id: true, status: true } });
  if (!order) throw notFound("Order");
  if (order.status === "PENDING_PAYMENT" || order.status === "EXPIRED") {
    const attempts = await db.paymentAttempt.findMany({
      where: { orderId: order.id, provider: { not: "DEV_SIMULATOR" }, providerOrderId: { not: null }, status: { in: ["CREATED", "PENDING", "AUTHORIZED", "CANCELLED", "FAILED"] } },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
    for (const at of attempts) {
      if (at.status === "FAILED" && at.failureReason?.startsWith("Amount mismatch")) continue;
      try {
        const creds = await credentialsForAttempt(at.provider, at.configId);
        const p = await getProvider(at.provider).fetchPayment(creds, { providerOrderId: at.providerOrderId!, providerPaymentId: at.providerPaymentId });
        if (p) await applyPaymentEvent(ctx, { provider: at.provider, payment: { ...p, providerOrderId: p.providerOrderId ?? at.providerOrderId }, source: "API_FETCH", attemptId: at.id });
      } catch (e) {
        if (!(e instanceof AppError)) throw e; // provider outage or rejected credentials: keep current state
      }
    }
  }
  return getPaymentStatus(id);
}

const checkoutReturnSchema = z.object({
  publicId: z.string().trim().min(8).max(100),
  providerOrderId: z.string().trim().min(1).max(100),
  providerPaymentId: z.string().trim().min(1).max(100),
  signature: z.string().trim().min(1).max(256),
});

/**
 * Razorpay checkout-return proof: the browser hands us order_id, payment_id and signature. A valid HMAC
 * (constant-time compare) proves the payment belongs to our provider order. Without a valid signature this
 * never changes state (a bare browser return is not proof). The amount is confirmed from the provider when
 * reachable; if the provider cannot be reached the signed order amount (fixed server-side when the provider
 * order was created) is used.
 */
export async function verifyCheckoutReturn(ctx: Ctx, input: unknown): Promise<PaymentStatusView> {
  const d = parse(checkoutReturnSchema, input);
  const order = await db.order.findUnique({ where: { publicId: d.publicId }, select: { id: true } });
  if (!order) throw notFound("Order");
  const attempt = await db.paymentAttempt.findFirst({ where: { orderId: order.id, providerOrderId: d.providerOrderId } });
  if (!attempt) throw notFound("Payment");
  const provider = getProvider(attempt.provider);
  const creds = await credentialsForAttempt(attempt.provider, attempt.configId);
  if (!provider.verifyCheckoutSignature(creds, { providerOrderId: d.providerOrderId, providerPaymentId: d.providerPaymentId, signature: d.signature })) {
    throw new AppError("BAD_REQUEST", "Payment signature could not be verified", { reason: "INVALID_SIGNATURE" });
  }
  let payment: NormalizedPayment | null = null;
  try {
    payment = await provider.fetchPayment(creds, { providerOrderId: d.providerOrderId, providerPaymentId: d.providerPaymentId });
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
  }
  if (payment && payment.providerPaymentId !== d.providerPaymentId) payment = null;
  if (payment && payment.status !== "SUCCEEDED") {
    // The provider says it did not succeed: record that state instead of trusting the signature alone.
    await applyPaymentEvent(ctx, { provider: attempt.provider, payment: { ...payment, providerOrderId: d.providerOrderId }, source: "CHECKOUT_SIGNATURE", attemptId: attempt.id });
  } else {
    const p: NormalizedPayment = payment ?? {
      providerOrderId: d.providerOrderId,
      providerPaymentId: d.providerPaymentId,
      status: "SUCCEEDED",
      amountMinor: attempt.amountMinor,
      currency: attempt.currency,
      method: attempt.method,
    };
    await applyPaymentEvent(ctx, { provider: attempt.provider, payment: { ...p, providerOrderId: d.providerOrderId }, source: "CHECKOUT_SIGNATURE", attemptId: attempt.id });
  }
  return getPaymentStatus(d.publicId);
}

// ---------------------------------------------------------------------------------------------
// Expiry (cron)

/** Expire unpaid orders past their expiresAt and cancel their open attempts. Safe to run repeatedly. */
export async function expireStaleOrders(now: Date = new Date(), batch = 500): Promise<{ expired: number; attemptsCancelled: number }> {
  const stale = await db.order.findMany({ where: { status: "PENDING_PAYMENT", expiresAt: { lt: now } }, select: { id: true }, take: batch });
  let expired = 0;
  let attemptsCancelled = 0;
  for (const s of stale) {
    await db.$transaction(async (tx) => {
      const row = await lockOrder(tx, s.id);
      if (!row || row.status !== "PENDING_PAYMENT") return;
      await tx.order.update({ where: { id: s.id }, data: { status: "EXPIRED" } });
      const open = await tx.paymentAttempt.findMany({ where: { orderId: s.id, status: { in: [...OPEN] } } });
      for (const at of open) {
        await setAttempt(tx, at, "CANCELLED", "SYSTEM", "Order expired", { failureReason: "Order expired" });
        attemptsCancelled++;
      }
      expired++;
    });
  }
  if (expired > 0) {
    await audit(systemCtx(), { action: "order.expire_sweep", entityType: "Order", metadata: { expired, attemptsCancelled } });
  }
  return { expired, attemptsCancelled };
}

export { badRequest };
