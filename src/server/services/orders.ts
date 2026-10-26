import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { randomCode, randomToken, dateStamp, withUniqueCode } from "@/lib/ids";
import { enforceRateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { effectiveTaxBps, MAX_TOTAL_MINOR, priceCart, type CartLineInput, type OfferRule } from "@/lib/pricing";
import { pageQuery, skipTake, toPage, type Page } from "@/lib/pagination";
import { idSchema, optionalPhone, optionalText, parse, emailSchema } from "@/lib/validation";
import { assertBusinessAccess, businessScope, requireActor, requireAdmin, requireClient } from "@/server/auth/guards";
import type { Ctx } from "@/server/auth/types";
import { getOrderExpiryMinutes } from "./settings";
import { findOfferByCode } from "./offers";

const optionalEmail = z.union([emailSchema, z.literal("").transform(() => undefined)]).optional();

const createOrderSchema = z.object({
  qrToken: z.string().trim().min(8).max(120).optional(),
  businessCode: z.string().trim().min(3).max(40).optional(),
  items: z
    .array(z.object({ productId: idSchema, quantity: z.number().int().min(1, "Quantity must be at least 1").max(100, "Quantity must be at most 100") }))
    .max(50, "Too many items in the cart")
    .default([]),
  customAmountMinor: z.number().int().min(1).max(MAX_TOTAL_MINOR).optional(),
  couponCode: z
    .string()
    .trim()
    .max(40)
    .transform((s) => (s === "" ? undefined : s))
    .optional(),
  customer: z
    .object({ name: optionalText(120), phone: optionalPhone, email: optionalEmail })
    .default({}),
  note: optionalText(500),
  idempotencyKey: z
    .string()
    .trim()
    .min(8, "Idempotency key is too short")
    .max(100)
    .regex(/^[A-Za-z0-9._:-]+$/, "Idempotency key has invalid characters"),
});

export interface OrderCreated {
  orderId: string;
  orderCode: string;
  publicId: string;
  status: string;
  currency: string;
  totalMinor: number;
  expiresAt: string;
  /** True when an earlier order with the same idempotency key was returned. */
  replayed: boolean;
}

const unavailable = (msg: string, reason: string, extra: Record<string, unknown> = {}) =>
  new AppError("BAD_REQUEST", msg, { reason, ...extra });

/**
 * Create a PENDING_PAYMENT order from an untrusted customer request (no session needed).
 *
 * Pricing authority: client supplied prices are never read (the schema strips unknown fields). Items are
 * loaded from the database for the QR/business, priced with `priceCart` (src/lib/pricing.ts) and the coupon
 * is resolved with `findOfferByCode`. The QR is validated inline (ACTIVE, not expired, same business) instead
 * of via `resolveQr`, which has scan-count side effects.
 *
 * Stock is only checked here (soft); it is decremented when the payment is verified (see payment-verification).
 * A coupon's usedCount is incremented only on verified payment.
 */
export async function createOrder(ctx: Ctx, input: unknown): Promise<OrderCreated> {
  const d = parse(createOrderSchema, input);
  await enforceRateLimit(`order:create:ip:${ctx.ip ?? "unknown"}`, 30, 300, "Too many orders from this network. Please wait a few minutes.");

  if (!d.qrToken && !d.businessCode) throw badRequest("A QR code or business code is required");

  const bizInclude = { client: { select: { status: true } } } as const;
  let qr: Prisma.QrCodeGetPayload<object> | null = null;
  let business: Prisma.BusinessGetPayload<{ include: typeof bizInclude }> | null = null;

  if (d.qrToken) {
    const row = await db.qrCode.findUnique({ where: { token: d.qrToken }, include: { business: { include: bizInclude } } });
    if (!row) throw notFound("QR code");
    const { business: b, ...q } = row;
    qr = q;
    business = b;
    if (d.businessCode && d.businessCode !== b.businessCode) throw badRequest("This QR code does not belong to that business");
  } else {
    business = await db.business.findUnique({ where: { businessCode: d.businessCode! }, include: bizInclude });
    if (!business) throw notFound("Business");
  }

  if (qr) {
    if (qr.status !== "ACTIVE") throw unavailable("This QR code is no longer active", "QR_INACTIVE");
    if (qr.expiresAt && qr.expiresAt.getTime() <= Date.now()) throw unavailable("This QR code has expired", "QR_EXPIRED");
    if (qr.type === "ORDER") throw unavailable("This QR code is for an existing order", "QR_ORDER_TYPE");
  }
  if (business.client.status !== "ACTIVE" || business.status !== "ACTIVE") {
    throw unavailable("This business is not available right now", "BUSINESS_UNAVAILABLE");
  }
  if (!business.acceptingOrders) throw unavailable("This business is not accepting orders right now", "NOT_ACCEPTING_ORDERS");

  // Idempotent replay: same (business, key) returns the existing order.
  const existing = await db.order.findUnique({ where: { businessId_idempotencyKey: { businessId: business.id, idempotencyKey: d.idempotencyKey } } });
  if (existing) return toCreated(existing, true);

  // Merge duplicate product lines.
  const merged = new Map<string, number>();
  for (const it of d.items) merged.set(it.productId, (merged.get(it.productId) ?? 0) + it.quantity);
  for (const q of merged.values()) if (q > 100) throw badRequest("Quantity must be at most 100 per item");
  let wanted = [...merged.entries()].map(([productId, quantity]) => ({ productId, quantity }));

  // Decide the amount mode.
  type Mode = { kind: "custom"; amountMinor: number } | { kind: "items" };
  let mode: Mode;
  if (qr?.fixedAmountMinor != null) {
    if (wanted.length > 0) throw badRequest("This QR code has a fixed amount and cannot be combined with items");
    if (d.customAmountMinor != null && d.customAmountMinor !== qr.fixedAmountMinor) {
      throw badRequest("This QR code has a fixed amount", { reason: "FIXED_AMOUNT" });
    }
    if (d.couponCode) throw badRequest("Coupons cannot be used with a fixed or custom amount");
    mode = { kind: "custom", amountMinor: qr.fixedAmountMinor };
  } else if (wanted.length > 0) {
    if (d.customAmountMinor != null) throw badRequest("Choose either items or a custom amount, not both");
    mode = { kind: "items" };
  } else if (d.customAmountMinor != null) {
    const allowed = Boolean(qr?.allowCustomAmount || business.allowCustomAmount);
    if (!allowed) throw badRequest("Custom amounts are not allowed here", { reason: "CUSTOM_AMOUNT_NOT_ALLOWED" });
    if (qr?.minAmountMinor != null && d.customAmountMinor < qr.minAmountMinor) {
      throw badRequest("The amount is below the minimum allowed", { reason: "AMOUNT_TOO_LOW", minAmountMinor: qr.minAmountMinor });
    }
    if (qr?.maxAmountMinor != null && d.customAmountMinor > qr.maxAmountMinor) {
      throw badRequest("The amount is above the maximum allowed", { reason: "AMOUNT_TOO_HIGH", maxAmountMinor: qr.maxAmountMinor });
    }
    if (d.couponCode) throw badRequest("Coupons cannot be used with a fixed or custom amount");
    mode = { kind: "custom", amountMinor: d.customAmountMinor };
  } else if (qr?.type === "PRODUCT" && qr.productId) {
    wanted = [{ productId: qr.productId, quantity: 1 }];
    mode = { kind: "items" };
  } else {
    throw badRequest("Add at least one item or enter an amount");
  }

  let lines: CartLineInput[];
  let names: string[];
  let productIds: (string | null)[];
  let offer: { id: string; rule: OfferRule; code: string } | null = null;

  if (mode.kind === "custom") {
    lines = [{ unitPriceMinor: mode.amountMinor, quantity: 1, taxBps: 0, discountType: "NONE", discountValue: 0 }];
    names = ["Payment"];
    productIds = [null];
  } else {
    const products = await db.product.findMany({ where: { id: { in: wanted.map((w) => w.productId) }, businessId: business.id } });
    const byId = new Map(products.map((p) => [p.id, p]));
    lines = [];
    names = [];
    productIds = [];
    for (const w of wanted) {
      const p = byId.get(w.productId);
      if (!p) throw unavailable("One of the items is not available", "PRODUCT_NOT_FOUND", { productId: w.productId });
      if (!p.isAvailable || p.archivedAt) throw unavailable(`${p.name} is not available right now`, "PRODUCT_UNAVAILABLE", { productId: p.id });
      if (p.trackInventory && p.stockQty < w.quantity) {
        throw unavailable(`${p.name} does not have enough stock`, "OUT_OF_STOCK", { productId: p.id });
      }
      lines.push({
        unitPriceMinor: p.priceMinor,
        quantity: w.quantity,
        taxBps: effectiveTaxBps(p, business),
        discountType: p.discountType,
        discountValue: p.discountValue,
      });
      names.push(p.name);
      productIds.push(p.id);
    }
    if (d.couponCode) {
      const o = await findOfferByCode(business.id, d.couponCode);
      if (!o) throw badRequest("This coupon is not valid", { reason: "INVALID" });
      offer = {
        id: o.id,
        code: o.code,
        rule: {
          type: o.type,
          value: o.value,
          minOrderMinor: o.minOrderMinor,
          maxDiscountMinor: o.maxDiscountMinor,
          validFrom: o.validFrom,
          validTo: o.validTo,
          usageLimit: o.usageLimit,
          usedCount: o.usedCount,
          isActive: o.isActive,
        },
      };
    }
  }

  const pricing = priceCart(lines, { pricesIncludeTax: business.pricesIncludeTax, offer: offer?.rule ?? null });
  if (pricing.totalMinor < 1) throw badRequest("The order total must be greater than zero");

  const minutes = await getOrderExpiryMinutes();
  const expiresAt = new Date(Date.now() + minutes * 60_000);
  const c = d.customer;

  try {
    const order = await db.$transaction(async (tx) => {
      let customerId: string | null = null;
      if (c.phone) {
        const cu = await tx.customer.upsert({
          where: { businessId_phone: { businessId: business.id, phone: c.phone } },
          create: { businessId: business.id, phone: c.phone, name: c.name ?? null, email: c.email ?? null },
          update: { ...(c.name ? { name: c.name } : {}), ...(c.email ? { email: c.email } : {}) },
        });
        customerId = cu.id;
      }
      const created = await withUniqueCode(
        () => randomCode(`ORD-${dateStamp()}`, 6),
        (orderCode) =>
          tx.order.create({
            data: {
              orderCode,
              publicId: randomToken(18),
              businessId: business.id,
              qrCodeId: qr?.id ?? null,
              customerId,
              offerId: offer?.id ?? null,
              couponCode: offer?.code ?? null,
              customerName: c.name ?? null,
              customerPhone: c.phone ?? null,
              customerEmail: c.email ?? null,
              note: d.note ?? null,
              currency: business.currency,
              subtotalMinor: pricing.subtotalMinor,
              discountMinor: pricing.discountMinor,
              taxMinor: pricing.taxMinor,
              totalMinor: pricing.totalMinor,
              idempotencyKey: d.idempotencyKey,
              expiresAt,
              items: {
                create: pricing.lines.map((l, i) => ({
                  productId: productIds[i],
                  name: names[i],
                  unitPriceMinor: l.unitPriceMinor,
                  quantity: l.quantity,
                  discountMinor: l.discountMinor + l.offerDiscountMinor,
                  taxBps: l.taxBps,
                  taxMinor: l.taxMinor,
                  lineTotalMinor: l.totalMinor,
                })),
              },
            },
          }),
      );
      await audit(
        ctx,
        {
          action: "order.create",
          entityType: "Order",
          entityId: created.id,
          clientId: business.clientId,
          metadata: { orderCode: created.orderCode, businessId: business.id, totalMinor: created.totalMinor, items: pricing.lines.length, viaQr: Boolean(qr) },
        },
        tx,
      );
      return created;
    });
    return toCreated(order, false);
  } catch (e) {
    // Two concurrent requests with the same idempotency key: the loser returns the winner's order.
    if ((e as { code?: string })?.code === "P2002") {
      const again = await db.order.findUnique({ where: { businessId_idempotencyKey: { businessId: business.id, idempotencyKey: d.idempotencyKey } } });
      if (again) return toCreated(again, true);
    }
    throw e;
  }
}

function toCreated(o: { id: string; orderCode: string; publicId: string; status: string; currency: string; totalMinor: number; expiresAt: Date }, replayed: boolean): OrderCreated {
  return {
    orderId: o.id,
    orderCode: o.orderCode,
    publicId: o.publicId,
    status: o.status,
    currency: o.currency,
    totalMinor: o.totalMinor,
    expiresAt: o.expiresAt.toISOString(),
    replayed,
  };
}

// ---------------------------------------------------------------------------------------------
// Public (customer facing) read model, addressed by the unguessable publicId.

export interface PublicOrderView {
  publicId: string;
  orderCode: string;
  status: string;
  currency: string;
  businessName: string;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  expiresAt: string;
  paidAt: string | null;
  couponCode: string | null;
  items: { name: string; quantity: number; unitPriceMinor: number; lineTotalMinor: number }[];
}

export async function getPublicOrder(publicId: unknown): Promise<PublicOrderView> {
  const id = parse(z.string().trim().min(8).max(100), publicId);
  const o = await db.order.findUnique({ where: { publicId: id }, include: { items: { orderBy: { id: "asc" } }, business: { select: { name: true } } } });
  if (!o) throw notFound("Order");
  return {
    publicId: o.publicId,
    orderCode: o.orderCode,
    status: o.status,
    currency: o.currency,
    businessName: o.business.name,
    subtotalMinor: o.subtotalMinor,
    discountMinor: o.discountMinor,
    taxMinor: o.taxMinor,
    totalMinor: o.totalMinor,
    expiresAt: o.expiresAt.toISOString(),
    paidAt: o.paidAt?.toISOString() ?? null,
    couponCode: o.couponCode,
    items: o.items.map((i) => ({ name: i.name, quantity: i.quantity, unitPriceMinor: i.unitPriceMinor, lineTotalMinor: i.lineTotalMinor })),
  };
}

// ---------------------------------------------------------------------------------------------
// Admin / client order listing, detail and cancel.

const dateStr = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .optional()
  .or(z.literal("").transform(() => undefined));

const orderListSchema = pageQuery.extend({
  clientId: idSchema.optional().or(z.literal("").transform(() => undefined)),
  businessId: idSchema.optional().or(z.literal("").transform(() => undefined)),
  status: z.enum(["PENDING_PAYMENT", "PAID", "CANCELLED", "EXPIRED", "PARTIALLY_REFUNDED", "REFUNDED"]).optional().or(z.literal("").transform(() => undefined)),
  from: dateStr,
  to: dateStr,
});

export function dayRange(from?: string, to?: string): { gte?: Date; lt?: Date } | undefined {
  if (!from && !to) return undefined;
  const r: { gte?: Date; lt?: Date } = {};
  if (from) r.gte = new Date(`${from}T00:00:00.000Z`);
  if (to) r.lt = new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 86_400_000);
  return r;
}

const orderListSelect = {
  id: true,
  orderCode: true,
  status: true,
  customerName: true,
  customerPhone: true,
  currency: true,
  totalMinor: true,
  createdAt: true,
  paidAt: true,
  expiresAt: true,
  business: { select: { id: true, name: true, businessCode: true, clientId: true, client: { select: { id: true, name: true } } } },
} satisfies Prisma.OrderSelect;

export type OrderListRow = Prisma.OrderGetPayload<{ select: typeof orderListSelect }>;

export async function listOrders(ctx: Ctx, input: unknown): Promise<Page<OrderListRow>> {
  const q = parse(orderListSchema, input ?? {});
  const a = requireActor(ctx);
  if (a.role === "CLIENT") requireClient(ctx, "payments.view");
  const scope = businessScope(ctx);
  const where: Prisma.OrderWhereInput = {};
  if (scope) where.businessId = scope;
  if (q.businessId) {
    if (scope) {
      if (!a.businessIds.includes(q.businessId)) throw notFound("Business");
    }
    where.businessId = q.businessId;
  }
  if (q.clientId && a.role === "SUPER_ADMIN") where.business = { clientId: q.clientId };
  if (q.status) where.status = q.status;
  const range = dayRange(q.from, q.to);
  if (range) where.createdAt = range;
  if (q.q) {
    where.OR = [
      { orderCode: { contains: q.q, mode: "insensitive" } },
      { customerName: { contains: q.q, mode: "insensitive" } },
      { customerPhone: { contains: q.q } },
    ];
  }
  const [items, total] = await Promise.all([
    db.order.findMany({ where, select: orderListSelect, orderBy: { createdAt: "desc" }, ...skipTake(q) }),
    db.order.count({ where }),
  ]);
  return toPage(items, total, q);
}

/** Order detail with items, attempts, transactions, refunds. Out-of-tenant ids are 404. */
export async function getOrder(ctx: Ctx, id: unknown) {
  const orderId = parse(idSchema, id);
  const a = requireActor(ctx);
  if (a.role === "CLIENT") requireClient(ctx, "payments.view");
  const o = await db.order.findUnique({
    where: { id: orderId },
    include: {
      items: { orderBy: { id: "asc" } },
      business: { select: { id: true, name: true, businessCode: true, clientId: true, client: { select: { id: true, name: true } } } },
      attempts: { orderBy: { createdAt: "asc" }, select: { id: true, provider: true, method: true, status: true, amountMinor: true, failureReason: true, createdAt: true } },
      transactions: { orderBy: { verifiedAt: "asc" }, select: { id: true, txnRef: true, provider: true, status: true, amountMinor: true, refundedMinor: true, isDuplicate: true, verifiedAt: true } },
      refunds: { orderBy: { createdAt: "asc" }, select: { id: true, refundRef: true, amountMinor: true, status: true, reason: true, createdAt: true } },
    },
  });
  if (!o) throw notFound("Order");
  if (a.role === "CLIENT") {
    if (o.business.clientId !== a.clientId || !a.businessIds.includes(o.businessId)) throw notFound("Order");
  }
  return o;
}

/** Cancel an unpaid order (admin, or a client with orders.manage). Open attempts are cancelled too. */
export async function cancelOrder(ctx: Ctx, input: unknown) {
  const { orderId } = parse(z.object({ orderId: idSchema }), input);
  const a = requireActor(ctx);
  if (a.role === "CLIENT") requireClient(ctx, "orders.manage");
  else requireAdmin(ctx);
  const o = await db.order.findUnique({ where: { id: orderId }, select: { id: true, businessId: true } });
  if (!o) throw notFound("Order");
  const business = await assertBusinessAccess(ctx, o.businessId, a.role === "CLIENT" ? "orders.manage" : undefined);

  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ status: string }[]>`SELECT "status" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE`;
    if (!rows[0]) throw notFound("Order");
    if (rows[0].status !== "PENDING_PAYMENT") throw new AppError("CONFLICT", "Only unpaid orders can be cancelled", { status: rows[0].status });
    await tx.order.update({ where: { id: orderId }, data: { status: "CANCELLED" } });
    const open = await tx.paymentAttempt.findMany({ where: { orderId, status: { in: ["CREATED", "PENDING", "AUTHORIZED"] } } });
    for (const at of open) {
      await tx.paymentAttempt.update({ where: { id: at.id }, data: { status: "CANCELLED", failureReason: "Order cancelled" } });
      await tx.paymentStatusHistory.create({ data: { attemptId: at.id, fromStatus: at.status, toStatus: "CANCELLED", source: "SYSTEM", note: "Order cancelled" } });
    }
    await audit(ctx, { action: "order.cancel", entityType: "Order", entityId: orderId, clientId: business.clientId, metadata: { cancelledAttempts: open.length } }, tx);
    return { id: orderId, status: "CANCELLED" as const };
  });
}
