import { randomBytes } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { parseRupees } from "@/lib/money";
import { pageQuery, skipTake, toPage } from "@/lib/pagination";
import { enforceRateLimit } from "@/lib/rate-limit";
import { emailSchema, idSchema, parse } from "@/lib/validation";
import { requireAdmin, requireUser } from "@/server/auth/guards";
import type { Ctx } from "@/server/auth/types";
import {
  gatewayConfig,
  initiatePayment,
  mapGatewayState,
  paiseFromAmountString,
  retrieveTransaction,
  sanitizeGatewayPayload,
  verifyResponseHash,
  amountString,
  type GatewayState,
} from "@/server/gateway/easebuzz";
import { recordActivity } from "./activity";
import type { Prisma } from "@/generated/prisma/client";

/** Smallest and largest online payment, in paise. */
export const MIN_PAYMENT_PAISE = 100; // Rs 1
export const MAX_PAYMENT_PAISE = 50_000_000; // Rs 5,00,000

/** 160 bits of crypto randomness: unguessable and unique. 22 chars, within Easebuzz's 40 character limit. */
export const newTxnId = () => `YP${randomBytes(10).toString("hex").toUpperCase()}`;

const payInput = z.object({
  amount: z.union([z.string(), z.number()]),
  purpose: z.string().trim().min(3, "Say what the payment is for (at least 3 characters)").max(100, "Purpose is too long"),
  email: z.union([emailSchema, z.literal("")]).optional(),
});

/** Easebuzz is strict about punctuation in free-text fields, and "|" would break the hash string. */
const plain = (s: string, max: number) => s.replace(/[^A-Za-z0-9 .,_-]/g, "").replace(/\s+/g, " ").trim().slice(0, max);

/** "+919876543210" -> "9876543210" (Easebuzz wants the national number). */
function nationalPhone(mobile: string): string {
  const digits = mobile.replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function callbackUrl(): string {
  return `${env().APP_URL.replace(/\/+$/, "")}/api/payments/callback`;
}

/** Whether online payments are switched on. Safe to show to anyone: it carries no secrets. */
export function gatewayStatus() {
  const cfg = gatewayConfig();
  const e = env();
  return {
    configured: !!cfg,
    mode: e.EASEBUZZ_ENV,
    webhookTokenSet: !!e.EASEBUZZ_WEBHOOK_TOKEN,
    webhookHash: e.EASEBUZZ_WEBHOOK_HASH,
    callbackUrl: callbackUrl(),
    refundWebhookUrl: `${e.APP_URL.replace(/\/+$/, "")}/api/payments/refund-webhook`,
  };
}

// ---------- paying ----------

/** Start an online payment for the signed-in user. Returns where to send the browser. */
export async function startPayment(ctx: Ctx, input: unknown) {
  const actor = requireUser(ctx);
  const d = parse(payInput, input);
  const amountPaise = parseRupees(d.amount);
  if (amountPaise === null || amountPaise === "invalid") {
    throw new AppError("VALIDATION", "Enter a valid amount, like 250 or 250.50", { fields: { amount: "Enter a valid amount" } });
  }
  if (amountPaise < MIN_PAYMENT_PAISE || amountPaise > MAX_PAYMENT_PAISE) {
    throw new AppError("VALIDATION", "Amount must be between ₹1 and ₹5,00,000", { fields: { amount: "Between ₹1 and ₹5,00,000" } });
  }
  const user = await db.user.findUnique({ where: { id: actor.userId }, select: { id: true, name: true, email: true, mobile: true, status: true } });
  if (!user || user.status !== "ACTIVE") throw notFound("User");
  // No made-up phone number: the gateway needs a real one, so ask the user for it.
  if (!user.mobile || nationalPhone(user.mobile).length !== 10) {
    throw new AppError("VALIDATION", "Add a valid mobile number to your account before paying online.", { fields: { mobile: "Mobile number required" } });
  }
  const cfg = gatewayConfig();
  if (!cfg) throw new AppError("GATEWAY_UNAVAILABLE", "Online payments are not available right now.");
  await enforceRateLimit(`pay:user:${user.id}`, 10, 600, "Too many payment attempts. Please wait a few minutes.");

  const txnId = newTxnId();
  const email = d.email || user.email || `user-${user.id}@example.invalid`;
  const payment = await db.payment.create({
    data: { userId: user.id, txnId, amountPaise, purpose: d.purpose, status: "CREATED", method: "EASEBUZZ", gatewayMode: cfg.env },
    select: { id: true, txnId: true },
  });
  await recordActivity(ctx, {
    type: "payment.initiated",
    targetUserId: user.id,
    paymentId: payment.id,
    paymentRef: txnId,
    toStatus: "CREATED",
    metadata: { amount: amountString(amountPaise), purpose: d.purpose, mode: cfg.env },
  });

  try {
    const url = callbackUrl();
    const { checkoutUrl } = await initiatePayment(
      {
        txnid: txnId,
        amount: amountString(amountPaise),
        productinfo: plain(d.purpose, 100) || "Payment",
        firstname: plain(user.name, 50) || "Customer",
        email,
        phone: nationalPhone(user.mobile),
        surl: url,
        furl: url,
        udf1: payment.id,
      },
      cfg,
    );
    const moved = await db.payment.updateMany({ where: { id: payment.id, status: "CREATED" }, data: { status: "PENDING" } });
    if (moved.count === 1) {
      await recordActivity(ctx, { type: "payment.redirected", targetUserId: user.id, paymentId: payment.id, paymentRef: txnId, fromStatus: "CREATED", toStatus: "PENDING" });
    }
    return { paymentId: payment.id, txnId, checkoutUrl };
  } catch (e) {
    const reason = e instanceof AppError ? e.message : "Could not start the payment";
    await db.payment.updateMany({ where: { id: payment.id, status: "CREATED" }, data: { status: "FAILED", failureReason: reason.slice(0, 300) } });
    await recordActivity(ctx, {
      type: "payment.initiate.failed",
      targetUserId: user.id,
      paymentId: payment.id,
      paymentRef: txnId,
      fromStatus: "CREATED",
      toStatus: "FAILED",
      metadata: { reason: reason.slice(0, 300) },
    });
    throw e;
  }
}

// ---------- applying a gateway result (callback or reconcile) ----------

type Source = "callback" | "reconcile";

interface Outcome {
  state: GatewayState;
  /** Amount the gateway says was paid, in paise (null when missing or unreadable). */
  paidPaise: number | null;
  easebuzzId: string | null;
  mode: string | null;
  message: string | null;
  raw: Record<string, unknown>;
}

export type ApplyResult = "success" | "failed" | "pending" | "mismatch" | "replay";

/**
 * Move a payment to its final state. Atomic and idempotent: the update only matches a payment that is
 * still CREATED/PENDING, so a replayed or concurrent callback cannot overwrite the first outcome.
 */
async function applyOutcome(ctx: Ctx, payment: { id: string; userId: string; txnId: string; amountPaise: number; status: string }, o: Outcome, source: Source): Promise<ApplyResult> {
  const base = { targetUserId: payment.userId, paymentId: payment.id, paymentRef: payment.txnId };
  if (o.state === "pending") return "pending";

  if (o.state === "success" && o.paidPaise !== payment.amountPaise) {
    // Never mark paid when the amount differs from what we asked for.
    const reason = `Amount mismatch: expected ${amountString(payment.amountPaise)}, gateway reported ${o.paidPaise === null ? "unreadable" : amountString(o.paidPaise)}`;
    await db.payment.updateMany({
      where: { id: payment.id, status: { in: ["CREATED", "PENDING"] } },
      data: { failureReason: reason, easebuzzId: o.easebuzzId ?? undefined, gatewayResponse: o.raw as Prisma.InputJsonValue },
    });
    await recordActivity(
      ctx,
      {
        ...base,
        type: "payment.callback.rejected",
        actor: { type: "GATEWAY" },
        metadata: { reason: "amount mismatch", source, expected: amountString(payment.amountPaise), received: o.paidPaise === null ? null : amountString(o.paidPaise) },
      },
    );
    return "mismatch";
  }

  const toStatus = o.state === "success" ? "SUCCEEDED" : "FAILED";
  const changed = await db.$transaction(async (tx) => {
    const res = await tx.payment.updateMany({
      where: { id: payment.id, status: { in: ["CREATED", "PENDING"] } },
      data: {
        status: toStatus,
        easebuzzId: o.easebuzzId ?? undefined,
        paidAmountPaise: o.state === "success" ? o.paidPaise : null,
        failureReason: o.state === "failed" ? (o.message ?? "Payment was not completed").slice(0, 300) : null,
        gatewayResponse: o.raw as Prisma.InputJsonValue,
        paidAt: o.state === "success" ? new Date() : null,
      },
    });
    if (res.count !== 1) return false;
    await recordActivity(
      ctx,
      {
        ...base,
        type: "payment.status.changed",
        actor: source === "callback" ? { type: "GATEWAY" } : undefined,
        fromStatus: payment.status,
        toStatus,
        metadata: { source, mode: o.mode, easebuzzId: o.easebuzzId },
      },
      tx,
    );
    return true;
  });
  if (!changed) return "replay";
  return o.state === "success" ? "success" : "failed";
}

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");

/**
 * Handle the browser redirect Easebuzz sends to surl/furl. Public: trust comes from the response hash.
 * Always safe to call twice with the same payload.
 */
export async function handlePaymentCallback(ctx: Ctx, payload: Record<string, unknown>): Promise<{ paymentId: string | null; result: ApplyResult | "rejected" }> {
  const txnId = str(payload.txnid, 60);
  const hashOk = verifyResponseHash(payload);
  const payment = txnId ? await db.payment.findUnique({ where: { txnId }, select: { id: true, userId: true, txnId: true, amountPaise: true, status: true } }) : null;
  const ref = { paymentId: payment?.id ?? null, targetUserId: payment?.userId ?? null, paymentRef: txnId || null };
  await recordActivity(ctx, {
    ...ref,
    type: "payment.callback.received",
    actor: { type: "GATEWAY" },
    metadata: { verified: hashOk, gatewayStatus: str(payload.status, 30), amount: str(payload.amount, 20), knownPayment: !!payment },
  });

  if (!hashOk) {
    await recordActivity(ctx, { ...ref, type: "payment.callback.rejected", actor: { type: "GATEWAY" }, metadata: { reason: "response check failed" } });
    // The payment (if any) is left exactly as it was.
    return { paymentId: payment?.id ?? null, result: "rejected" };
  }
  if (!payment) {
    await recordActivity(ctx, { ...ref, type: "payment.callback.rejected", actor: { type: "GATEWAY" }, metadata: { reason: "unknown transaction" } });
    return { paymentId: null, result: "rejected" };
  }
  const state = mapGatewayState(payload.status);
  if (!state) {
    await recordActivity(ctx, { ...ref, type: "payment.callback.rejected", actor: { type: "GATEWAY" }, metadata: { reason: "unknown status" } });
    return { paymentId: payment.id, result: "rejected" };
  }
  const result = await applyOutcome(
    ctx,
    payment,
    {
      state,
      paidPaise: paiseFromAmountString(payload.amount),
      easebuzzId: str(payload.easepayid, 60) || null,
      mode: str(payload.mode, 30) || null,
      message: str(payload.error_Message || payload.error, 200) || null,
      raw: sanitizeGatewayPayload(payload) ?? {},
    },
    "callback",
  );
  if (result === "replay") {
    await recordActivity(ctx, { ...ref, type: "payment.callback.rejected", actor: { type: "GATEWAY" }, metadata: { reason: "already final, first outcome kept", currentStatus: payment.status } });
  }
  return { paymentId: payment.id, result };
}

// ---------- reconcile ----------

const OPEN: Array<"CREATED" | "PENDING"> = ["CREATED", "PENDING"];

/** Ask Easebuzz about one open payment and apply the answer. */
export async function reconcilePayment(ctx: Ctx, id: string) {
  requireAdmin(ctx);
  const p = await db.payment.findUnique({ where: { id }, select: { id: true, userId: true, txnId: true, amountPaise: true, status: true, method: true } });
  if (!p) throw notFound("Payment");
  if (p.method !== "EASEBUZZ") throw badRequest("Only online payments can be checked with the gateway.");
  if (!OPEN.includes(p.status as "CREATED" | "PENDING")) throw badRequest(`This payment is already ${p.status.toLowerCase().replace("_", " ")}.`);

  const txn = await retrieveTransaction(p.txnId);
  const ref = { targetUserId: p.userId, paymentId: p.id, paymentRef: p.txnId };
  if (!txn || txn.txnid !== p.txnId) {
    await recordActivity(ctx, { ...ref, type: "payment.reconciled", metadata: { result: "unclear answer from the gateway" } });
    return { id, status: p.status, result: "unknown" as const };
  }
  const result = await applyOutcome(
    ctx,
    p,
    { state: txn.state, paidPaise: paiseFromAmountString(txn.amount), easebuzzId: txn.easebuzzId, mode: txn.mode, message: txn.message, raw: txn.raw },
    "reconcile",
  );
  await recordActivity(ctx, { ...ref, type: "payment.reconciled", metadata: { result, gatewayState: txn.state } });
  const now = await db.payment.findUnique({ where: { id }, select: { status: true } });
  return { id, status: now?.status ?? p.status, result };
}

/** Reconcile every payment still open after `olderThanMinutes` (default 5). Stops early on the first gateway outage. */
export async function reconcilePending(ctx: Ctx, input: unknown = {}) {
  requireAdmin(ctx);
  const { olderThanMinutes, limit } = parse(z.object({ olderThanMinutes: z.coerce.number().int().min(0).max(1440).default(5), limit: z.coerce.number().int().min(1).max(100).default(25) }), input);
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
  const open = await db.payment.findMany({
    where: { method: "EASEBUZZ", status: "PENDING", createdAt: { lte: cutoff } },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true },
  });
  const summary = { checked: 0, updated: 0, unchanged: 0, errors: 0 };
  for (const { id } of open) {
    try {
      const r = await reconcilePayment(ctx, id);
      summary.checked++;
      if (r.result === "success" || r.result === "failed") summary.updated++;
      else summary.unchanged++;
    } catch (e) {
      summary.errors++;
      if (e instanceof AppError && e.code === "GATEWAY_UNAVAILABLE") break;
    }
  }
  return summary;
}

// ---------- reading ----------

const refundPublic = { id: true, merchantRefundId: true, amountPaise: true, reason: true, status: true, failureReason: true, createdAt: true, updatedAt: true } as const;

const statusEnum = z.enum(["CREATED", "PENDING", "SUCCEEDED", "FAILED", "PARTIALLY_REFUNDED", "REFUNDED"]);

export async function listPaymentsForUser(ctx: Ctx, raw: unknown) {
  const actor = requireUser(ctx);
  const q = parse(pageQuery.extend({ status: statusEnum.optional() }), raw);
  const where: Prisma.PaymentWhereInput = { userId: actor.userId, ...(q.status ? { status: q.status } : {}) };
  const [items, total] = await Promise.all([
    db.payment.findMany({
      where,
      orderBy: { createdAt: "desc" },
      ...skipTake(q),
      select: { id: true, txnId: true, amountPaise: true, purpose: true, status: true, method: true, createdAt: true, paidAt: true, refunds: { select: { amountPaise: true, status: true } } },
    }),
    db.payment.count({ where }),
  ]);
  return toPage(items, total, q);
}

/** One of the user's own payments with its refunds. Never returns the raw gateway response. */
export async function getPaymentForUser(ctx: Ctx, id: string) {
  const actor = requireUser(ctx);
  const p = await db.payment.findFirst({
    where: { id: parse(idSchema, id), userId: actor.userId },
    select: {
      id: true, txnId: true, amountPaise: true, purpose: true, status: true, method: true, easebuzzId: true, failureReason: true,
      paidAmountPaise: true, paidAt: true, createdAt: true, refunds: { orderBy: { createdAt: "asc" }, select: refundPublic },
    },
  });
  if (!p) throw notFound("Payment");
  return p;
}

const listAdminQuery = pageQuery.extend({
  status: statusEnum.optional(),
  method: z.enum(["EASEBUZZ", "QR"]).optional(),
  userId: z.string().max(64).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export async function listPaymentsAdmin(ctx: Ctx, raw: unknown) {
  requireAdmin(ctx);
  const q = parse(listAdminQuery, raw);
  const createdAt: Prisma.DateTimeFilter = {};
  if (q.from) createdAt.gte = new Date(`${q.from}T00:00:00.000Z`);
  if (q.to) createdAt.lte = new Date(`${q.to}T23:59:59.999Z`);
  const where: Prisma.PaymentWhereInput = {
    ...(q.status ? { status: q.status } : {}),
    ...(q.method ? { method: q.method } : {}),
    ...(q.userId ? { userId: q.userId } : {}),
    ...(q.from || q.to ? { createdAt } : {}),
    ...(q.q
      ? {
          OR: [
            { txnId: { contains: q.q.toUpperCase().replace(/\s+/g, "") } },
            { easebuzzId: { contains: q.q.trim() } },
            { user: { username: { contains: q.q.toLowerCase() } } },
            { user: { name: { contains: q.q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    db.payment.findMany({
      where,
      orderBy: { createdAt: "desc" },
      ...skipTake(q),
      select: {
        id: true, txnId: true, easebuzzId: true, amountPaise: true, purpose: true, status: true, method: true, createdAt: true, paidAt: true,
        user: { select: { id: true, name: true, username: true } },
        refunds: { select: { amountPaise: true, status: true } },
      },
    }),
    db.payment.count({ where }),
  ]);
  return toPage(items, total, q);
}

/** Full detail for the admin, including the (sanitised) gateway response and every refund. */
export async function getPaymentAdmin(ctx: Ctx, id: string) {
  requireAdmin(ctx);
  const p = await db.payment.findUnique({
    where: { id: parse(idSchema, id) },
    include: {
      user: { select: { id: true, name: true, username: true, mobile: true, email: true } },
      refunds: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!p) throw notFound("Payment");
  return p;
}

/** Payments of one user (admin user-detail page). */
export async function recentPaymentsForUserAdmin(ctx: Ctx, userId: string) {
  requireAdmin(ctx);
  return db.payment.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true, txnId: true, amountPaise: true, purpose: true, status: true, createdAt: true },
  });
}
