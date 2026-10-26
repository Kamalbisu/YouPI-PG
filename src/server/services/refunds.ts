import { randomBytes } from "node:crypto";
import { z } from "zod";
import { safeEqual } from "@/lib/crypto";
import { db, type Tx } from "@/lib/db";
import { env } from "@/lib/env";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { amountString, gatewayConfig, generateRefundHash, paiseFromAmountString, requestRefund, sanitizeGatewayPayload } from "@/server/gateway/easebuzz";
import { formatRupees, parseRupees } from "@/lib/money";
import { idSchema, parse } from "@/lib/validation";
import { requireAdmin } from "@/server/auth/guards";
import type { Ctx } from "@/server/auth/types";
import { recordActivity } from "./activity";
import type { Prisma } from "@/generated/prisma/client";

/** Refunds that still count against the paid amount: everything except FAILED. */
const COUNTED = ["QUEUED", "PROCESSING", "PROCESSED"] as const;

const newMerchantRefundId = () => `YPR${randomBytes(8).toString("hex").toUpperCase()}`;

const refundInput = z.object({
  /** Blank = refund everything still refundable. */
  amount: z.union([z.string(), z.number()]).optional(),
  reason: z.string().trim().max(200).optional(),
});

/** Recompute the payment status from its PROCESSED refunds. Runs inside the caller's transaction. */
async function syncPaymentStatus(ctx: Ctx, tx: Tx, paymentId: string) {
  const p = await tx.payment.findUnique({ where: { id: paymentId }, select: { id: true, userId: true, txnId: true, status: true, paidAmountPaise: true } });
  if (!p || p.paidAmountPaise === null) return;
  if (!["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"].includes(p.status)) return;
  const agg = await tx.refund.aggregate({ where: { paymentId, status: "PROCESSED" }, _sum: { amountPaise: true } });
  const done = agg._sum.amountPaise ?? 0;
  const next = done >= p.paidAmountPaise ? "REFUNDED" : done > 0 ? "PARTIALLY_REFUNDED" : "SUCCEEDED";
  if (next === p.status) return;
  const res = await tx.payment.updateMany({ where: { id: paymentId, status: p.status as "SUCCEEDED" }, data: { status: next } });
  if (res.count === 1) {
    await recordActivity(ctx, { type: "payment.status.changed", targetUserId: p.userId, paymentId, paymentRef: p.txnId, fromStatus: p.status, toStatus: next, metadata: { source: "refund" } }, tx);
  }
}

type Settle = { status: "PROCESSING" | "PROCESSED" | "FAILED"; gatewayRefundId?: string | null; failureReason?: string | null; raw?: Record<string, unknown> | null; source: string };

/**
 * Move a refund forward. Atomic and idempotent: only QUEUED/PROCESSING refunds can change, and
 * PROCESSED/FAILED are final, so a replayed webhook keeps the first outcome.
 */
async function settleRefund(ctx: Ctx, refundId: string, s: Settle): Promise<"changed" | "unchanged"> {
  return db.$transaction(async (tx) => {
    const r = await tx.refund.findUnique({ where: { id: refundId }, include: { payment: { select: { id: true, userId: true, txnId: true } } } });
    if (!r) return "unchanged";
    const from = r.status;
    const allowedFrom = s.status === "PROCESSING" ? ["QUEUED"] : ["QUEUED", "PROCESSING"];
    const res = await tx.refund.updateMany({
      where: { id: refundId, status: { in: allowedFrom as ("QUEUED" | "PROCESSING")[] } },
      data: {
        status: s.status,
        gatewayRefundId: s.gatewayRefundId ?? undefined,
        failureReason: s.status === "FAILED" ? (s.failureReason ?? "Refund was not accepted").slice(0, 300) : null,
        gatewayResponse: s.raw ? (s.raw as Prisma.InputJsonValue) : undefined,
      },
    });
    if (res.count !== 1) return "unchanged";
    const base = { targetUserId: r.payment.userId, paymentId: r.payment.id, refundId: r.id, paymentRef: r.payment.txnId, fromStatus: from, toStatus: s.status };
    if (s.status === "PROCESSED") await recordActivity(ctx, { ...base, type: "refund.processed", metadata: { source: s.source, amount: amountString(r.amountPaise) } }, tx);
    else if (s.status === "FAILED") await recordActivity(ctx, { ...base, type: "refund.failed", metadata: { source: s.source, reason: (s.failureReason ?? "").slice(0, 300) } }, tx);
    else await recordActivity(ctx, { ...base, type: "refund.queued", metadata: { source: s.source, step: "accepted by gateway" } }, tx);
    await syncPaymentStatus(ctx, tx, r.paymentId);
    return "changed";
  });
}

const DONE_WORDS = ["refunded", "success", "successful", "completed", "processed", "settled"];
const FAIL_WORDS = ["failed", "failure", "cancelled", "canceled", "rejected", "reversed"];

/** Send a QUEUED refund to the gateway and record what came back. The row already exists. */
async function sendToGateway(ctx: Ctx, refund: { id: string; merchantRefundId: string; amountPaise: number }, easebuzzId: string) {
  // A thrown error (timeout, outage, non-JSON reply) means the outcome is unknown: the refund stays QUEUED
  // so it keeps counting against the limit, and the error is shown to the admin.
  const result = await requestRefund({ easebuzzId, amountPaise: refund.amountPaise, merchantRefundId: refund.merchantRefundId });
  if (!result.accepted) {
    await settleRefund(ctx, refund.id, { status: "FAILED", failureReason: result.message ?? "The gateway did not accept the refund", raw: result.raw, source: "request" });
    return "failed" as const;
  }
  const doneNow = DONE_WORDS.includes(String(result.raw.refund_status ?? result.raw.state ?? "").toLowerCase());
  await settleRefund(ctx, refund.id, { status: doneNow ? "PROCESSED" : "PROCESSING", gatewayRefundId: result.gatewayRefundId, raw: result.raw, source: "request" });
  return doneNow ? ("processed" as const) : ("processing" as const);
}

/**
 * Admin: refund all or part of a paid online payment.
 * The refund row is written (QUEUED) before the gateway is called, with a unique merchant refund id.
 */
export async function createRefund(ctx: Ctx, paymentId: string, input: unknown) {
  const admin = requireAdmin(ctx);
  const d = parse(refundInput, input ?? {});
  if (!gatewayConfig()) throw new AppError("GATEWAY_UNAVAILABLE", "Online payments are not configured, so refunds are unavailable.");

  const { refund, easebuzzId } = await db.$transaction(async (tx) => {
    // Lock the payment so two refunds cannot both pass the limit check.
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM payments WHERE id = ${parse(idSchema, paymentId)} FOR UPDATE`;
    if (locked.length === 0) throw notFound("Payment");
    const p = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    if (p.method !== "EASEBUZZ" || !p.easebuzzId || p.paidAmountPaise === null || !["SUCCEEDED", "PARTIALLY_REFUNDED"].includes(p.status)) {
      throw badRequest("Only a paid online payment that is not fully refunded can be refunded.");
    }
    const agg = await tx.refund.aggregate({ where: { paymentId, status: { in: [...COUNTED] } }, _sum: { amountPaise: true } });
    const remaining = p.paidAmountPaise - (agg._sum.amountPaise ?? 0);
    let amountPaise: number;
    if (d.amount === undefined || d.amount === "") amountPaise = remaining;
    else {
      const parsed = parseRupees(d.amount);
      if (parsed === null || parsed === "invalid" || parsed <= 0) throw new AppError("VALIDATION", "Enter a valid refund amount", { fields: { amount: "Enter a valid amount" } });
      amountPaise = parsed;
    }
    if (amountPaise <= 0 || amountPaise > remaining) {
      throw new AppError("VALIDATION", `Refund cannot exceed the amount still refundable (${formatRupees(Math.max(remaining, 0))}).`, { fields: { amount: `At most ${formatRupees(Math.max(remaining, 0))}` } });
    }
    let created;
    for (let i = 0; ; i++) {
      try {
        created = await tx.refund.create({
          data: { paymentId, merchantRefundId: newMerchantRefundId(), amountPaise, reason: d.reason || null, status: "QUEUED", requestedById: admin.userId },
        });
        break;
      } catch (e) {
        if ((e as { code?: string })?.code === "P2002" && i < 5) continue;
        throw e;
      }
    }
    const base = { targetUserId: p.userId, paymentId, refundId: created.id, paymentRef: p.txnId };
    await recordActivity(ctx, { ...base, type: "refund.requested", metadata: { amount: amountString(amountPaise), reason: d.reason ?? null, remainingBefore: amountString(remaining) } }, tx);
    await recordActivity(ctx, { ...base, type: "refund.queued", toStatus: "QUEUED", metadata: { merchantRefundId: created.merchantRefundId } }, tx);
    return { refund: created, easebuzzId: p.easebuzzId };
  });

  const outcome = await sendToGateway(ctx, refund, easebuzzId);
  const now = await db.refund.findUniqueOrThrow({ where: { id: refund.id } });
  return { refund: now, outcome };
}

/** Admin: re-send a refund that is still QUEUED (for example after a gateway outage). Uses the same merchant refund id. */
export async function retryRefund(ctx: Ctx, refundId: string) {
  requireAdmin(ctx);
  const r = await db.refund.findUnique({ where: { id: parse(idSchema, refundId) }, include: { payment: { select: { easebuzzId: true } } } });
  if (!r) throw notFound("Refund");
  if (r.status !== "QUEUED" || !r.payment.easebuzzId) throw badRequest("Only a queued refund can be re-sent.");
  const outcome = await sendToGateway(ctx, r, r.payment.easebuzzId);
  return { refund: await db.refund.findUniqueOrThrow({ where: { id: r.id } }), outcome };
}

// ---------- webhook ----------

export interface WebhookRequest {
  /** Token from the x-webhook-token header or the ?token= query. Never logged. */
  token: string | null;
  body: unknown;
}

function extractEvent(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  let data = (body as Record<string, unknown>).data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      data = null;
    }
  }
  return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : (body as Record<string, unknown>);
}

const s = (v: unknown, max = 100) => (typeof v === "string" || typeof v === "number" ? String(v).slice(0, max) : "");

export type WebhookResult = "unauthorized" | "applied" | "ignored";

/**
 * Easebuzz refund webhook. Authenticated by a shared secret token (required) and, when the payload
 * carries a hash and EASEBUZZ_WEBHOOK_HASH=refund, by that hash as well. Idempotent.
 */
export async function handleRefundWebhook(ctx: Ctx, req: WebhookRequest): Promise<WebhookResult> {
  const e = env();
  const expected = e.EASEBUZZ_WEBHOOK_TOKEN;
  const gctx: Ctx = ctx;
  if (!expected || !req.token || !safeEqual(req.token, expected)) {
    await recordActivity(gctx, { type: "refund.webhook.rejected", actor: { type: "GATEWAY" }, metadata: { reason: "bad or missing token" } });
    return "unauthorized";
  }
  const ev = extractEvent(req.body);
  const merchantRefundId = s(ev.merchant_refund_id);
  const refund = merchantRefundId
    ? await db.refund.findUnique({ where: { merchantRefundId }, include: { payment: { select: { id: true, userId: true, txnId: true, easebuzzId: true } } } })
    : null;
  const ref = refund ? { targetUserId: refund.payment.userId, paymentId: refund.payment.id, refundId: refund.id, paymentRef: refund.payment.txnId } : {};

  // Hash check, when the payload carries one.
  const given = s(ev.hash, 200);
  const cfg = gatewayConfig();
  if (given && e.EASEBUZZ_WEBHOOK_HASH === "refund") {
    const easeId = s(ev.easebuzz_id) || refund?.payment.easebuzzId || "";
    const amount = s(ev.refund_amount, 20);
    const ok = !!cfg && !!merchantRefundId && !!easeId && !!amount && safeEqual(given.toLowerCase(), generateRefundHash(merchantRefundId, easeId, amount, cfg));
    if (!ok) {
      await recordActivity(gctx, { ...ref, type: "refund.webhook.rejected", actor: { type: "GATEWAY" }, metadata: { reason: "payload check failed" } });
      return "unauthorized";
    }
  }

  const state = s(ev.refund_status || ev.state || ev.status, 30).toLowerCase();
  await recordActivity(gctx, { ...ref, type: "refund.webhook.received", actor: { type: "GATEWAY" }, metadata: { state, known: !!refund, payloadChecked: !!given && e.EASEBUZZ_WEBHOOK_HASH === "refund" } });
  if (!refund) return "ignored";

  const raw = sanitizeGatewayPayload(ev) ?? {};
  const gatewayRefundId = s(ev.refund_id) || null;
  if (DONE_WORDS.includes(state)) {
    // A refund must never be marked done for a different amount than we asked for.
    const paid = paiseFromAmountString(ev.refund_amount);
    if (paid !== null && paid !== refund.amountPaise) {
      await recordActivity(gctx, { ...ref, type: "refund.webhook.rejected", actor: { type: "GATEWAY" }, metadata: { reason: "amount mismatch", expected: amountString(refund.amountPaise), received: amountString(paid) } });
      return "ignored";
    }
    return (await settleRefund(gctx, refund.id, { status: "PROCESSED", gatewayRefundId, raw, source: "webhook" })) === "changed" ? "applied" : "ignored";
  }
  if (FAIL_WORDS.includes(state)) {
    return (await settleRefund(gctx, refund.id, { status: "FAILED", gatewayRefundId, failureReason: "The gateway reported the refund as failed", raw, source: "webhook" })) === "changed" ? "applied" : "ignored";
  }
  if (["queued", "accepted", "pending", "processing"].includes(state)) {
    return (await settleRefund(gctx, refund.id, { status: "PROCESSING", gatewayRefundId, raw, source: "webhook" })) === "changed" ? "applied" : "ignored";
  }
  return "ignored";
}
