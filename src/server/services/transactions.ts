import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { notFound } from "@/lib/errors";
import { minorToMajorString } from "@/lib/money";
import { pageQuery, skipTake, toPage, type Page } from "@/lib/pagination";
import { idSchema, parse } from "@/lib/validation";
import { businessScope, requireActor, requireClient } from "@/server/auth/guards";
import type { Ctx } from "@/server/auth/types";
import { toCsv, type CsvColumn } from "./csv";
import { dayRange } from "./orders";

/**
 * Transaction ledger queries.
 *
 * A "verified" payment is a PaymentTransaction row: rows are only created by recordVerifiedPayment
 * (webhook, provider fetch or checkout signature), never from a browser redirect.
 * Money shown here is always integer minor units.
 *   gross    = transaction amount
 *   refunded = sum of PROCESSED refunds (kept on the transaction)
 *   fee      = feeMinor + feeTaxMinor (provider fee and tax on fee, when the provider reported them; 0 otherwise)
 *   net      = gross - refunded - fee
 */

export interface TxnScope {
  clientId?: string;
  /** Restrict to these businesses. An empty array matches nothing. */
  businessIds?: string[];
  from?: Date;
  /** Exclusive upper bound. */
  to?: Date;
  /** Duplicate payments (second capture on an already-paid order) are excluded from revenue unless asked for. */
  includeDuplicates?: boolean;
}

const VERIFIED_STATUSES = ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"] as const;

/**
 * Prisma where for verified successful/refunded transactions.
 * Duplicates (isDuplicate) are excluded by default because they are not revenue; they are handled via reconciliation.
 */
export function verifiedTxnWhere(scope: TxnScope = {}): Prisma.PaymentTransactionWhereInput {
  const where: Prisma.PaymentTransactionWhereInput = { status: { in: [...VERIFIED_STATUSES] } };
  if (!scope.includeDuplicates) where.isDuplicate = false;
  const order: Prisma.OrderWhereInput = {};
  if (scope.businessIds) order.businessId = { in: scope.businessIds };
  if (scope.clientId) order.business = { clientId: scope.clientId };
  if (Object.keys(order).length) where.order = order;
  if (scope.from || scope.to) {
    where.verifiedAt = { ...(scope.from ? { gte: scope.from } : {}), ...(scope.to ? { lt: scope.to } : {}) };
  }
  return where;
}

export interface TxnSummary {
  count: number;
  grossMinor: number;
  refundedMinor: number;
  feeMinor: number;
  netMinor: number;
}

/** SQL aggregate over verified transactions. Integer sums only (cast to bigint then number: totals stay far below 2^53). */
export async function summarizeTransactions(scope: TxnScope = {}): Promise<TxnSummary> {
  const zero: TxnSummary = { count: 0, grossMinor: 0, refundedMinor: 0, feeMinor: 0, netMinor: 0 };
  if (scope.businessIds && scope.businessIds.length === 0) return zero;
  const conds: Prisma.Sql[] = [Prisma.sql`t."status"::text IN ('SUCCEEDED','PARTIALLY_REFUNDED','REFUNDED')`];
  if (!scope.includeDuplicates) conds.push(Prisma.sql`t."isDuplicate" = false`);
  if (scope.businessIds) conds.push(Prisma.sql`o."businessId" IN (${Prisma.join(scope.businessIds)})`);
  if (scope.clientId) conds.push(Prisma.sql`b."clientId" = ${scope.clientId}`);
  if (scope.from) conds.push(Prisma.sql`t."verifiedAt" >= ${scope.from}`);
  if (scope.to) conds.push(Prisma.sql`t."verifiedAt" < ${scope.to}`);
  const rows = await db.$queryRaw<{ count: bigint; gross: bigint | null; refunded: bigint | null; fee: bigint | null }[]>(Prisma.sql`
    SELECT COUNT(*)::bigint AS count,
           COALESCE(SUM(t."amountMinor"), 0)::bigint AS gross,
           COALESCE(SUM(t."refundedMinor"), 0)::bigint AS refunded,
           COALESCE(SUM(COALESCE(t."feeMinor", 0) + COALESCE(t."feeTaxMinor", 0)), 0)::bigint AS fee
    FROM "payment_transactions" t
    JOIN "orders" o ON o."id" = t."orderId"
    JOIN "businesses" b ON b."id" = o."businessId"
    WHERE ${Prisma.join(conds, " AND ")}
  `);
  const r = rows[0];
  if (!r) return zero;
  const gross = Number(r.gross ?? 0);
  const refunded = Number(r.refunded ?? 0);
  const fee = Number(r.fee ?? 0);
  return { count: Number(r.count), grossMinor: gross, refundedMinor: refunded, feeMinor: fee, netMinor: gross - refunded - fee };
}

// ---------------------------------------------------------------------------------------------
// Listing, detail, export

const dateStr = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .optional()
  .or(z.literal("").transform(() => undefined));
const emptyToUndef = <T extends z.ZodTypeAny>(s: T) => s.optional().or(z.literal("").transform(() => undefined));

const txnListSchema = pageQuery.extend({
  clientId: emptyToUndef(idSchema),
  businessId: emptyToUndef(idSchema),
  provider: emptyToUndef(z.enum(["RAZORPAY", "CASHFREE", "DEV_SIMULATOR"])),
  status: emptyToUndef(z.enum(["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"])),
  method: emptyToUndef(z.string().trim().max(40)),
  from: dateStr,
  to: dateStr,
});

const txnSelect = {
  id: true,
  txnRef: true,
  provider: true,
  providerPaymentId: true,
  method: true,
  status: true,
  amountMinor: true,
  refundedMinor: true,
  feeMinor: true,
  feeTaxMinor: true,
  currency: true,
  isDuplicate: true,
  verificationSource: true,
  verifiedAt: true,
  order: {
    select: {
      id: true,
      orderCode: true,
      customerName: true,
      business: { select: { id: true, name: true, businessCode: true, clientId: true, client: { select: { id: true, name: true } } } },
    },
  },
} satisfies Prisma.PaymentTransactionSelect;

export type TxnListRow = Prisma.PaymentTransactionGetPayload<{ select: typeof txnSelect }> & { feeTotalMinor: number; netMinor: number };

function decorate(r: Prisma.PaymentTransactionGetPayload<{ select: typeof txnSelect }>): TxnListRow {
  const feeTotalMinor = (r.feeMinor ?? 0) + (r.feeTaxMinor ?? 0);
  return { ...r, feeTotalMinor, netMinor: r.amountMinor - r.refundedMinor - feeTotalMinor };
}

function buildWhere(ctx: Ctx, q: z.infer<typeof txnListSchema>, permission: string): Prisma.PaymentTransactionWhereInput {
  const a = requireActor(ctx);
  if (a.role === "CLIENT") requireClient(ctx, permission);
  const scope = businessScope(ctx);
  const order: Prisma.OrderWhereInput = {};
  if (scope) order.businessId = scope;
  if (q.businessId) {
    if (scope && !a.businessIds.includes(q.businessId)) throw notFound("Business");
    order.businessId = q.businessId;
  }
  if (q.clientId && a.role === "SUPER_ADMIN") order.business = { clientId: q.clientId };
  // All recorded transactions are listed (duplicates are flagged in the row); revenue totals exclude them.
  const where: Prisma.PaymentTransactionWhereInput = {};
  if (Object.keys(order).length) where.order = order;
  if (q.provider) where.provider = q.provider;
  if (q.status) where.status = q.status;
  if (q.method) where.method = q.method;
  const range = dayRange(q.from, q.to);
  if (range) where.verifiedAt = range;
  if (q.q) {
    where.OR = [
      { txnRef: { contains: q.q, mode: "insensitive" } },
      { providerPaymentId: { contains: q.q, mode: "insensitive" } },
      { order: { orderCode: { contains: q.q, mode: "insensitive" } } },
    ];
  }
  return where;
}

export async function listTransactions(ctx: Ctx, input: unknown): Promise<Page<TxnListRow>> {
  const q = parse(txnListSchema, input ?? {});
  const where = buildWhere(ctx, q, "payments.view");
  const [items, total] = await Promise.all([
    db.paymentTransaction.findMany({ where, select: txnSelect, orderBy: { verifiedAt: "desc" }, ...skipTake(q) }),
    db.paymentTransaction.count({ where }),
  ]);
  return toPage(items.map(decorate), total, q);
}

/** Totals for the filtered result set (verified, non-duplicate). Same filters and tenant scope as the list. */
export async function transactionTotals(ctx: Ctx, input: unknown): Promise<TxnSummary> {
  const q = parse(txnListSchema, input ?? {});
  const a = requireActor(ctx);
  if (a.role === "CLIENT") requireClient(ctx, "payments.view");
  const scope = businessScope(ctx);
  let businessIds: string[] | undefined = scope ? [...a.businessIds] : undefined;
  if (q.businessId) {
    if (scope && !a.businessIds.includes(q.businessId)) throw notFound("Business");
    businessIds = [q.businessId];
  }
  const range = dayRange(q.from, q.to);
  return summarizeTransactions({
    businessIds,
    clientId: a.role === "SUPER_ADMIN" ? q.clientId : a.clientId ?? undefined,
    from: range?.gte,
    to: range?.lt,
  });
}

export async function getTransaction(ctx: Ctx, id: unknown) {
  const txnId = parse(idSchema, id);
  const a = requireActor(ctx);
  if (a.role === "CLIENT") requireClient(ctx, "payments.view");
  const t = await db.paymentTransaction.findUnique({
    where: { id: txnId },
    select: {
      ...txnSelect,
      createdAt: true,
      order: {
        select: {
          id: true,
          orderCode: true,
          status: true,
          customerName: true,
          customerPhone: true,
          customerEmail: true,
          currency: true,
          subtotalMinor: true,
          discountMinor: true,
          taxMinor: true,
          totalMinor: true,
          paidAt: true,
          createdAt: true,
          businessId: true,
          business: { select: { id: true, name: true, businessCode: true, clientId: true, client: { select: { id: true, name: true } } } },
          items: { orderBy: { id: "asc" }, select: { id: true, name: true, unitPriceMinor: true, quantity: true, discountMinor: true, taxMinor: true, lineTotalMinor: true } },
        },
      },
      attempt: {
        select: {
          id: true,
          status: true,
          provider: true,
          method: true,
          createdAt: true,
          history: { orderBy: { createdAt: "asc" }, select: { id: true, fromStatus: true, toStatus: true, source: true, note: true, createdAt: true } },
        },
      },
      refunds: { orderBy: { createdAt: "asc" }, select: { id: true, refundRef: true, amountMinor: true, status: true, reason: true, failureReason: true, createdAt: true, processedAt: true } },
    },
  });
  if (!t) throw notFound("Transaction");
  if (a.role === "CLIENT") {
    if (t.order.business.clientId !== a.clientId || !a.businessIds.includes(t.order.businessId)) throw notFound("Transaction");
  }
  const pendingMinor = t.refunds.filter((r) => r.status === "PENDING").reduce((s, r) => s + r.amountMinor, 0);
  const feeTotalMinor = (t.feeMinor ?? 0) + (t.feeTaxMinor ?? 0);
  return {
    ...t,
    feeTotalMinor,
    netMinor: t.amountMinor - t.refundedMinor - feeTotalMinor,
    refundableMinor: Math.max(0, t.amountMinor - t.refundedMinor - pendingMinor),
  };
}

export type TxnDetail = Awaited<ReturnType<typeof getTransaction>>;

const EXPORT_MAX_ROWS = 10_000;

const exportColumns: CsvColumn<TxnListRow>[] = [
  { header: "Transaction", get: (r) => r.txnRef },
  { header: "Verified at", get: (r) => r.verifiedAt },
  { header: "Client", get: (r) => r.order.business.client.name },
  { header: "Business", get: (r) => r.order.business.name },
  { header: "Order", get: (r) => r.order.orderCode },
  { header: "Customer", get: (r) => r.order.customerName },
  { header: "Provider", get: (r) => r.provider },
  { header: "Method", get: (r) => r.method },
  { header: "Provider payment id", get: (r) => r.providerPaymentId },
  { header: "Status", get: (r) => r.status },
  { header: "Duplicate", get: (r) => r.isDuplicate },
  { header: "Currency", get: (r) => r.currency },
  { header: "Gross", get: (r) => minorToMajorString(r.amountMinor) },
  { header: "Refunded", get: (r) => minorToMajorString(r.refundedMinor) },
  { header: "Fee", get: (r) => minorToMajorString(r.feeTotalMinor) },
  { header: "Net", get: (r) => minorToMajorString(r.netMinor) },
];

/** CSV of the filtered transactions. Client actors need reports.export. Capped at 10,000 rows. */
export async function exportTransactionsCsv(ctx: Ctx, input: unknown): Promise<{ filename: string; csv: string; truncated: boolean }> {
  const q = parse(txnListSchema, input ?? {});
  const where = buildWhere(ctx, q, "reports.export");
  const rows = await db.paymentTransaction.findMany({ where, select: txnSelect, orderBy: { verifiedAt: "desc" }, take: EXPORT_MAX_ROWS + 1 });
  const truncated = rows.length > EXPORT_MAX_ROWS;
  const csv = toCsv(rows.slice(0, EXPORT_MAX_ROWS).map(decorate), exportColumns);
  return { filename: `transactions-${new Date().toISOString().slice(0, 10)}.csv`, csv, truncated };
}
