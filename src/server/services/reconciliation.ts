import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { notFound } from "@/lib/errors";
import { idSchema, parse } from "@/lib/validation";
import { requireAdmin } from "@/server/auth/guards";
import type { Ctx } from "@/server/auth/types";
import { refreshPaymentStatus } from "./payment-verification";

/**
 * Admin reconciliation: things that need a human or a re-check.
 * "Reviewed" state is stored in the audit log (action reconciliation.reviewed, entityId "<KIND>:<id>") so it is
 * append-only and attributable; a reviewed item is hidden from the default lists but never deleted.
 */

export const RECON_KINDS = ["STUCK_ATTEMPT", "PAID_WITHOUT_TXN", "TXN_ORDER_MISMATCH", "DUPLICATE_PAYMENT", "AMOUNT_MISMATCH", "LATE_PAYMENT", "FAILED_WEBHOOK"] as const;
export type ReconKind = (typeof RECON_KINDS)[number];

export interface ReconItem {
  kind: ReconKind;
  /** Review target id: attempt id, order id, transaction id or webhook event id depending on kind. */
  id: string;
  title: string;
  detail: string;
  orderId: string | null;
  orderCode: string | null;
  businessName: string | null;
  amountMinor: number | null;
  currency: string | null;
  at: string;
  reviewed: boolean;
  reviewNote: string | null;
}

export interface ReconSection {
  kind: ReconKind;
  label: string;
  total: number;
  items: ReconItem[];
}

export const RECON_LABELS: Record<ReconKind, string> = {
  STUCK_ATTEMPT: "Stuck payment attempts",
  PAID_WITHOUT_TXN: "Paid orders without a verified transaction",
  TXN_ORDER_MISMATCH: "Transaction and order disagree",
  DUPLICATE_PAYMENT: "Duplicate payments awaiting refund",
  AMOUNT_MISMATCH: "Amount or currency mismatches",
  LATE_PAYMENT: "Late payments on expired orders",
  FAILED_WEBHOOK: "Failed webhooks",
};

const LIMIT = 100;
const reviewKey = (kind: ReconKind, id: string) => `${kind}:${id}`;

const listSchema = z.object({
  stuckMinutes: z.coerce.number().int().min(1).max(7 * 24 * 60).default(30),
  includeReviewed: z.coerce.boolean().default(false),
});

export async function listReconciliation(ctx: Ctx, input: unknown): Promise<{ stuckMinutes: number; sections: ReconSection[]; openCount: number }> {
  requireAdmin(ctx);
  const q = parse(listSchema, input ?? {});
  const cutoff = new Date(Date.now() - q.stuckMinutes * 60_000);
  const orderSel = { select: { id: true, orderCode: true, status: true, totalMinor: true, currency: true, business: { select: { name: true } } } } as const;

  const [stuck, paidNoTxn, mismatchTxns, dupes, amountMismatch, late, failedHooks] = await Promise.all([
    db.paymentAttempt.findMany({
      where: { status: { in: ["CREATED", "PENDING", "AUTHORIZED"] }, createdAt: { lt: cutoff } },
      orderBy: { createdAt: "asc" },
      take: LIMIT,
      include: { order: orderSel },
    }),
    db.order.findMany({
      where: { status: { in: ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"] }, transactions: { none: { isDuplicate: false } } },
      orderBy: { createdAt: "asc" },
      take: LIMIT,
      select: orderSel.select,
    }),
    // A verified transaction exists but the order is not settled, or the amounts differ.
    db.paymentTransaction.findMany({
      where: {
        isDuplicate: false,
        OR: [{ order: { status: { in: ["PENDING_PAYMENT", "CANCELLED"] } } }],
      },
      orderBy: { verifiedAt: "asc" },
      take: LIMIT,
      include: { order: orderSel },
    }),
    db.paymentTransaction.findMany({
      where: { isDuplicate: true, refundedMinor: 0, refunds: { none: { status: { in: ["PENDING", "PROCESSED"] } } } },
      orderBy: { verifiedAt: "asc" },
      take: LIMIT,
      include: { order: orderSel },
    }),
    db.paymentAttempt.findMany({
      where: { status: "FAILED", failureReason: { startsWith: "Amount mismatch" } },
      orderBy: { updatedAt: "desc" },
      take: LIMIT,
      include: { order: orderSel },
    }),
    db.paymentStatusHistory.findMany({
      where: { note: { startsWith: "LATE_PAYMENT" } },
      orderBy: { createdAt: "desc" },
      take: LIMIT,
      distinct: ["attemptId"],
      include: { attempt: { include: { order: orderSel } } },
    }),
    db.webhookEvent.findMany({ where: { status: "FAILED", signatureValid: true }, orderBy: { receivedAt: "desc" }, take: LIMIT }),
  ]);

  // Amount disagreement between a settled order and its first verified transaction.
  const amountDiff = await db.paymentTransaction.findMany({
    where: { isDuplicate: false, order: { status: { in: ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"] } } },
    orderBy: { verifiedAt: "desc" },
    take: 500,
    include: { order: orderSel },
  });
  const diffRows = amountDiff.filter((t) => t.amountMinor !== t.order.totalMinor || t.currency !== t.order.currency);

  const raw: ReconItem[] = [];
  const base = { reviewed: false, reviewNote: null } as const;
  for (const a of stuck) {
    raw.push({
      ...base,
      kind: "STUCK_ATTEMPT",
      id: a.id,
      title: `${a.provider} attempt ${a.status}`,
      detail: `Open for over ${q.stuckMinutes} minutes without a verified result`,
      orderId: a.order.id,
      orderCode: a.order.orderCode,
      businessName: a.order.business.name,
      amountMinor: a.amountMinor,
      currency: a.currency,
      at: a.createdAt.toISOString(),
    });
  }
  for (const o of paidNoTxn) {
    raw.push({ ...base, kind: "PAID_WITHOUT_TXN", id: o.id, title: "Order is paid but has no verified transaction", detail: `Order status ${o.status}`, orderId: o.id, orderCode: o.orderCode, businessName: o.business.name, amountMinor: o.totalMinor, currency: o.currency, at: new Date().toISOString() });
  }
  for (const t of mismatchTxns) {
    raw.push({ ...base, kind: "TXN_ORDER_MISMATCH", id: t.id, title: `Verified transaction on a ${t.order.status} order`, detail: `Transaction ${t.txnRef} is verified but the order was not settled`, orderId: t.order.id, orderCode: t.order.orderCode, businessName: t.order.business.name, amountMinor: t.amountMinor, currency: t.currency, at: t.verifiedAt.toISOString() });
  }
  for (const t of diffRows) {
    raw.push({ ...base, kind: "TXN_ORDER_MISMATCH", id: t.id, title: "Transaction amount differs from order total", detail: `Transaction ${t.txnRef}: ${t.currency} ${t.amountMinor} vs order ${t.order.currency} ${t.order.totalMinor} (minor units)`, orderId: t.order.id, orderCode: t.order.orderCode, businessName: t.order.business.name, amountMinor: t.amountMinor, currency: t.currency, at: t.verifiedAt.toISOString() });
  }
  for (const t of dupes) {
    raw.push({ ...base, kind: "DUPLICATE_PAYMENT", id: t.id, title: "Customer paid twice, refund needed", detail: `Transaction ${t.txnRef} is a duplicate of an earlier payment`, orderId: t.order.id, orderCode: t.order.orderCode, businessName: t.order.business.name, amountMinor: t.amountMinor, currency: t.currency, at: t.verifiedAt.toISOString() });
  }
  for (const a of amountMismatch) {
    raw.push({ ...base, kind: "AMOUNT_MISMATCH", id: a.id, title: "Provider amount did not match the order", detail: a.failureReason ?? "Amount mismatch", orderId: a.order.id, orderCode: a.order.orderCode, businessName: a.order.business.name, amountMinor: a.amountMinor, currency: a.currency, at: a.updatedAt.toISOString() });
  }
  for (const h of late) {
    const o = h.attempt.order;
    raw.push({ ...base, kind: "LATE_PAYMENT", id: o.id, title: "Payment arrived after the order expired", detail: "Verified and accepted; confirm with the business or refund", orderId: o.id, orderCode: o.orderCode, businessName: o.business.name, amountMinor: o.totalMinor, currency: o.currency, at: h.createdAt.toISOString() });
  }
  for (const w of failedHooks) {
    raw.push({ ...base, kind: "FAILED_WEBHOOK", id: w.id, title: `${w.provider} ${w.eventType}`, detail: w.error ?? "Processing failed", orderId: null, orderCode: null, businessName: null, amountMinor: null, currency: null, at: w.receivedAt.toISOString() });
  }

  // Reviewed markers (latest wins).
  const keys = raw.map((r) => reviewKey(r.kind, r.id));
  const reviews = keys.length
    ? await db.auditLog.findMany({ where: { action: "reconciliation.reviewed", entityType: "Reconciliation", entityId: { in: keys } }, orderBy: { createdAt: "desc" }, select: { entityId: true, metadata: true } })
    : [];
  const reviewed = new Map<string, string | null>();
  for (const r of reviews) if (r.entityId && !reviewed.has(r.entityId)) reviewed.set(r.entityId, ((r.metadata as { note?: string } | null)?.note ?? null) as string | null);

  const sections: ReconSection[] = RECON_KINDS.map((kind) => {
    const all = raw
      .filter((r) => r.kind === kind)
      .map((r) => {
        const k = reviewKey(r.kind, r.id);
        return reviewed.has(k) ? { ...r, reviewed: true, reviewNote: reviewed.get(k) ?? null } : r;
      });
    const visible = q.includeReviewed ? all : all.filter((r) => !r.reviewed);
    return { kind, label: RECON_LABELS[kind], total: visible.length, items: visible };
  });
  return { stuckMinutes: q.stuckMinutes, sections, openCount: sections.reduce((s, x) => s + x.items.filter((i) => !i.reviewed).length, 0) };
}

/** Re-asks the provider about an order's attempts. Verification still goes through the single choke point. */
export async function refetchOrderPayment(ctx: Ctx, input: unknown) {
  requireAdmin(ctx);
  const { orderId } = parse(z.object({ orderId: idSchema }), input);
  const o = await db.order.findUnique({ where: { id: orderId }, select: { id: true, publicId: true, orderCode: true, business: { select: { clientId: true } } } });
  if (!o) throw notFound("Order");
  const status = await refreshPaymentStatus(o.publicId, ctx);
  await audit(ctx, { action: "reconciliation.refetch", entityType: "Order", entityId: o.id, clientId: o.business.clientId, metadata: { orderCode: o.orderCode, paymentState: status.paymentState } });
  return { orderId: o.id, orderCode: o.orderCode, orderStatus: status.orderStatus, paymentState: status.paymentState };
}

const reviewSchema = z.object({
  kind: z.enum(RECON_KINDS),
  id: idSchema,
  note: z.string().trim().min(3, "Add a short note").max(500),
});

export async function markReconciliationReviewed(ctx: Ctx, input: unknown) {
  requireAdmin(ctx);
  const d = parse(reviewSchema, input);
  await audit(ctx, { action: "reconciliation.reviewed", entityType: "Reconciliation", entityId: reviewKey(d.kind, d.id), metadata: { kind: d.kind, targetId: d.id, note: d.note } });
  return { ok: true as const };
}
