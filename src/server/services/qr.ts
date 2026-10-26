import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { db, type Tx } from "@/lib/db";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { pepperHash } from "@/lib/crypto";
import { AppError, badRequest, conflict, notFound } from "@/lib/errors";
import { randomToken, withUniqueCode } from "@/lib/ids";
import { pageQuery, skipTake, toPage } from "@/lib/pagination";
import { amountMinorSchema, idSchema, parse } from "@/lib/validation";
import { assertBusinessAccess } from "@/server/auth/guards";
import type { Ctx } from "@/server/auth/types";
import { catalogActor, catalogScope } from "./categories";

const PERM = "qr.manage";
const TOKEN_BYTES = 24; // 32 base64url characters, 192 bits
const SCAN_DEDUP_MS = 60_000;
const STATS_DAYS = 30;

/** The only thing a QR image ever encodes. */
export function qrUrl(token: string): string {
  return `${env().APP_URL.replace(/\/+$/, "")}/pay/q/${token}`;
}

const bad = (field: string, msg: string) => new AppError("VALIDATION", msg, { fields: { [field]: msg } });

const dateField = z.union([z.string().trim().min(1), z.date()]).transform((v, c) => {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) {
    c.addIssue({ code: "custom", message: "Enter a valid date" });
    return z.NEVER;
  }
  return d;
});

const createSchema = z.object({
  businessId: idSchema,
  type: z.enum(["BUSINESS", "PRODUCT", "ORDER", "DYNAMIC_PAYMENT"]),
  label: z.string().trim().min(2, "Enter a label").max(80, "Keep it under 80 characters"),
  productId: idSchema.optional(),
  orderId: idSchema.optional(),
  fixedAmountMinor: amountMinorSchema.optional(),
  allowCustomAmount: z.boolean().default(false),
  minAmountMinor: amountMinorSchema.optional(),
  maxAmountMinor: amountMinorSchema.optional(),
  expiresAt: dateField.optional(),
});
type CreateInput = z.infer<typeof createSchema>;

const listSchema = pageQuery.extend({
  businessId: idSchema.optional(),
  clientId: idSchema.optional(),
  type: z.enum(["BUSINESS", "PRODUCT", "ORDER", "DYNAMIC_PAYMENT"]).optional(),
  status: z.enum(["all", "active", "revoked", "expired"]).default("all"),
});

const revokeSchema = z.object({
  id: idSchema,
  reason: z.string().trim().min(3, "Give a short reason").max(200, "Keep it under 200 characters"),
});

const regenerateSchema = z.object({
  id: idSchema,
  reason: z.string().trim().max(200).optional(),
});

function validateShape(d: CreateInput) {
  if (d.type === "PRODUCT" && !d.productId) throw bad("productId", "Choose a product");
  if (d.type !== "PRODUCT" && d.productId) throw bad("productId", "Only product QR codes link to a product");
  if (d.type === "ORDER" && !d.orderId) throw bad("orderId", "Choose an order");
  if (d.type !== "ORDER" && d.orderId) throw bad("orderId", "Only order QR codes link to an order");
  if (d.type === "DYNAMIC_PAYMENT") {
    if (d.fixedAmountMinor === undefined && !d.allowCustomAmount) throw bad("fixedAmountMinor", "Set a fixed amount or allow customers to enter one");
  } else if (d.fixedAmountMinor !== undefined) {
    throw bad("fixedAmountMinor", "Fixed amounts apply to payment QR codes only");
  }
  if (d.fixedAmountMinor !== undefined && d.allowCustomAmount) throw bad("allowCustomAmount", "Choose either a fixed amount or a custom amount");
  if ((d.minAmountMinor !== undefined || d.maxAmountMinor !== undefined) && !d.allowCustomAmount) {
    throw bad("minAmountMinor", "Minimum and maximum apply only when custom amounts are allowed");
  }
  if (d.minAmountMinor !== undefined && d.maxAmountMinor !== undefined && d.minAmountMinor > d.maxAmountMinor) {
    throw bad("maxAmountMinor", "Maximum must be at least the minimum");
  }
  if (d.expiresAt && d.expiresAt.getTime() <= Date.now()) throw bad("expiresAt", "Expiry must be in the future");
}

/** Insert a QR row with a fresh unguessable token (retries on the unlikely collision). */
function insertQr(tx: Tx, data: Omit<Prisma.QrCodeUncheckedCreateInput, "token">) {
  return withUniqueCode(
    () => randomToken(TOKEN_BYTES),
    (token) => tx.qrCode.create({ data: { ...data, token } }),
  );
}

const dto = <T extends { token: string }>(q: T) => ({ ...q, url: qrUrl(q.token) });

export async function createQr(ctx: Ctx, input: unknown) {
  catalogActor(ctx, PERM);
  const d = parse(createSchema, input);
  const business = await assertBusinessAccess(ctx, d.businessId, PERM);
  validateShape(d);
  if (business.status !== "ACTIVE") throw conflict("This business is not active");
  const actor = ctx.actor!;

  return db.$transaction(async (tx) => {
    if (d.productId) {
      const p = await tx.product.findUnique({ where: { id: d.productId }, select: { businessId: true, archivedAt: true } });
      if (!p || p.businessId !== d.businessId) throw notFound("Product");
      if (p.archivedAt) throw bad("productId", "This product is archived");
    }
    if (d.orderId) {
      const o = await tx.order.findUnique({ where: { id: d.orderId }, select: { businessId: true, expiresAt: true, boundQr: { select: { id: true } } } });
      if (!o || o.businessId !== d.businessId) throw notFound("Order");
      if (o.boundQr) throw conflict("This order already has a QR code");
      d.expiresAt = d.expiresAt ?? o.expiresAt;
    }
    const q = await insertQr(tx, {
      type: d.type,
      label: d.label,
      businessId: d.businessId,
      productId: d.productId ?? null,
      orderId: d.orderId ?? null,
      fixedAmountMinor: d.fixedAmountMinor ?? null,
      allowCustomAmount: d.allowCustomAmount,
      minAmountMinor: d.minAmountMinor ?? null,
      maxAmountMinor: d.maxAmountMinor ?? null,
      expiresAt: d.expiresAt ?? null,
      createdById: actor.userId,
    });
    await audit(ctx, { action: "qr.create", entityType: "QrCode", entityId: q.id, clientId: business.clientId, metadata: { businessId: q.businessId, type: q.type, label: q.label } }, tx);
    return dto(q);
  });
}

/**
 * For the payments service: create the one-off QR bound to an order, inside the order's transaction.
 * The QR expires together with the order.
 */
export async function createOrderQr(tx: Tx, input: { businessId: string; orderId: string; createdById?: string | null }) {
  const order = await tx.order.findUnique({ where: { id: input.orderId }, select: { orderCode: true, businessId: true, expiresAt: true } });
  if (!order || order.businessId !== input.businessId) throw notFound("Order");
  return insertQr(tx, {
    type: "ORDER",
    label: `Order ${order.orderCode}`,
    businessId: input.businessId,
    orderId: input.orderId,
    expiresAt: order.expiresAt,
    createdById: input.createdById ?? null,
  });
}

async function loadQr(ctx: Ctx, id: string) {
  const q = await db.qrCode.findUnique({ where: { id }, include: { business: { select: { id: true, name: true, clientId: true, status: true, logoFileId: true, client: { select: { name: true } } } } } });
  if (!q) throw notFound("QR code");
  await assertBusinessAccess(ctx, q.businessId, PERM); // 404 outside the tenant
  return q;
}

/** Loads a QR the actor may manage; used by the download routes. */
export async function getQrForDownload(ctx: Ctx, input: unknown) {
  catalogActor(ctx, PERM);
  const { id } = parse(z.object({ id: idSchema }), input);
  return loadQr(ctx, id);
}

export async function listQr(ctx: Ctx, input: unknown = {}) {
  const q = parse(listSchema, input ?? {});
  const scope = await catalogScope(ctx, PERM, q.businessId);
  const now = new Date();
  const where: Prisma.QrCodeWhereInput = { ...scope };
  if (q.type) where.type = q.type;
  if (q.clientId && ctx.actor?.role === "SUPER_ADMIN") where.business = { clientId: q.clientId };
  if (q.status === "revoked") where.status = "REVOKED";
  if (q.status === "active") Object.assign(where, { status: "ACTIVE", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] });
  if (q.status === "expired") Object.assign(where, { status: "ACTIVE", expiresAt: { lte: now } });
  if (q.q) {
    const and: Prisma.QrCodeWhereInput[] = [{ label: { contains: q.q, mode: "insensitive" } }];
    where.AND = [{ OR: and }];
  }
  const [rows, total] = await Promise.all([
    db.qrCode.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      ...skipTake(q),
      include: {
        business: { select: { id: true, name: true, clientId: true, client: { select: { name: true } } } },
        product: { select: { id: true, name: true } },
      },
    }),
    db.qrCode.count({ where }),
  ]);
  return toPage(rows.map(dto), total, q);
}

export async function getQr(ctx: Ctx, input: unknown) {
  catalogActor(ctx, PERM);
  const { id } = parse(z.object({ id: idSchema }), input);
  const q = await loadQr(ctx, id);

  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - (STATS_DAYS - 1));

  const orderWhere: Prisma.OrderWhereInput = { OR: [{ qrCodeId: id }, { boundQr: { is: { id } } }] };
  const [scans, ordersCount, revenue, product, replacement] = await Promise.all([
    db.qrScan.findMany({ where: { qrCodeId: id, scannedAt: { gte: since } }, select: { scannedAt: true }, take: 50_000 }),
    db.order.count({ where: orderWhere }),
    // Revenue counts verified payment transactions only; an order row alone is never revenue.
    db.paymentTransaction.aggregate({
      where: { order: orderWhere, isDuplicate: false },
      _sum: { amountMinor: true, refundedMinor: true },
      _count: { _all: true },
    }),
    q.productId ? db.product.findUnique({ where: { id: q.productId }, select: { id: true, name: true } }) : null,
    q.replacedById ? db.qrCode.findUnique({ where: { id: q.replacedById }, select: { id: true, label: true } }) : null,
  ]);

  const buckets = new Map<string, number>();
  for (let i = 0; i < STATS_DAYS; i++) {
    const d = new Date(since);
    d.setUTCDate(since.getUTCDate() + i);
    buckets.set(d.toISOString().slice(0, 10), 0);
  }
  for (const s of scans) {
    const k = s.scannedAt.toISOString().slice(0, 10);
    if (buckets.has(k)) buckets.set(k, (buckets.get(k) ?? 0) + 1);
  }
  const gross = revenue._sum.amountMinor ?? 0;
  const refunded = revenue._sum.refundedMinor ?? 0;
  return {
    ...dto(q),
    product,
    replacement,
    stats: {
      scanCount: q.scanCount,
      lastScannedAt: q.lastScannedAt,
      scansByDay: [...buckets].map(([date, count]) => ({ date, count })),
      ordersCount,
      paidTransactions: revenue._count._all,
      revenueMinor: gross,
      refundedMinor: refunded,
      netRevenueMinor: gross - refunded,
    },
  };
}

export async function revokeQr(ctx: Ctx, input: unknown) {
  catalogActor(ctx, PERM);
  const { id, reason } = parse(revokeSchema, input);
  const q = await loadQr(ctx, id);
  if (q.status === "REVOKED") throw conflict("This QR code is already revoked");
  return db.$transaction(async (tx) => {
    // Conditional update so two concurrent revokes cannot both succeed.
    const res = await tx.qrCode.updateMany({ where: { id, status: "ACTIVE" }, data: { status: "REVOKED", revokedAt: new Date(), revokedReason: reason } });
    if (res.count === 0) throw conflict("This QR code is already revoked");
    await audit(ctx, { action: "qr.revoke", entityType: "QrCode", entityId: id, clientId: q.business.clientId, metadata: { businessId: q.businessId, reason } }, tx);
    return dto(await tx.qrCode.findUniqueOrThrow({ where: { id } }));
  });
}

/** Issue a replacement (new token) and revoke the old one atomically. The old row keeps a replacedById link. */
export async function regenerateQr(ctx: Ctx, input: unknown) {
  catalogActor(ctx, PERM);
  const { id, reason } = parse(regenerateSchema, input);
  const old = await loadQr(ctx, id);
  if (old.type === "ORDER") throw badRequest("Order QR codes are bound to one order and cannot be regenerated");
  if (old.replacedById) throw conflict("This QR code was already replaced");
  if (old.business.status !== "ACTIVE") throw conflict("This business is not active");
  const actor = ctx.actor!;

  return db.$transaction(async (tx) => {
    const res = await tx.qrCode.updateMany({
      where: { id, replacedById: null },
      data: { status: "REVOKED", revokedAt: old.revokedAt ?? new Date(), revokedReason: old.revokedReason ?? (reason || "Replaced by a new QR code") },
    });
    if (res.count === 0) throw conflict("This QR code was already replaced");
    const fresh = await insertQr(tx, {
      type: old.type,
      label: old.label,
      businessId: old.businessId,
      productId: old.productId,
      fixedAmountMinor: old.fixedAmountMinor,
      allowCustomAmount: old.allowCustomAmount,
      minAmountMinor: old.minAmountMinor,
      maxAmountMinor: old.maxAmountMinor,
      expiresAt: old.expiresAt && old.expiresAt.getTime() > Date.now() ? old.expiresAt : null,
      createdById: actor.userId,
    });
    await tx.qrCode.update({ where: { id }, data: { replacedById: fresh.id } });
    await audit(ctx, { action: "qr.regenerate", entityType: "QrCode", entityId: id, clientId: old.business.clientId, metadata: { businessId: old.businessId, replacementId: fresh.id, reason: reason || null } }, tx);
    return dto(fresh);
  });
}

// ---------------------------------------------------------------------------
// Public resolution (customer scans the code)
// ---------------------------------------------------------------------------

export type QrState = "ok" | "revoked" | "expired" | "not_found" | "business_unavailable";

export type ResolveResult =
  | {
      state: "ok";
      qr: {
        id: string;
        token: string;
        type: "BUSINESS" | "PRODUCT" | "ORDER" | "DYNAMIC_PAYMENT";
        label: string;
        productId: string | null;
        orderId: string | null;
        fixedAmountMinor: number | null;
        allowCustomAmount: boolean;
        minAmountMinor: number | null;
        maxAmountMinor: number | null;
        expiresAt: Date | null;
      };
      business: {
        id: string;
        name: string;
        logoFileId: string | null;
        currency: string;
        acceptingOrders: boolean;
        pricesIncludeTax: boolean;
        defaultTaxBps: number;
        hoursText: string | null;
      };
    }
  | { state: "revoked" | "expired" | "not_found" | "business_unavailable"; qr: null; business: null };

function uaClass(ua: string | null | undefined): "mobile" | "desktop" | "other" {
  if (!ua) return "other";
  if (/bot|crawl|spider|curl|wget|python|java\/|okhttp|axios|node-fetch/i.test(ua)) return "other";
  if (/Mobi|Android|iPhone|iPad|iPod/i.test(ua)) return "mobile";
  if (/Windows|Macintosh|X11|Linux|CrOS/i.test(ua)) return "desktop";
  return "other";
}

const NONE = (state: "revoked" | "expired" | "not_found" | "business_unavailable"): ResolveResult => ({ state, qr: null, business: null });

/**
 * Resolve a scanned token. Non-ok states carry no QR or business data. A successful resolve counts one scan,
 * except repeat scans from the same (hashed) IP within 60 seconds. Raw IPs are never stored.
 */
export async function resolveQr(token: string, meta: { ip?: string | null; userAgent?: string | null } = {}): Promise<ResolveResult> {
  if (typeof token !== "string" || token.length < 8 || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) return NONE("not_found");
  const q = await db.qrCode.findUnique({
    where: { token },
    include: {
      business: { select: { id: true, name: true, logoFileId: true, currency: true, acceptingOrders: true, pricesIncludeTax: true, defaultTaxBps: true, hoursText: true, status: true } },
    },
  });
  if (!q) return NONE("not_found");
  if (q.status === "REVOKED") return NONE("revoked");
  const now = new Date();
  if (q.expiresAt && q.expiresAt.getTime() <= now.getTime()) return NONE("expired");
  if (q.business.status !== "ACTIVE") return NONE("business_unavailable");

  const ipHash = meta.ip ? pepperHash(meta.ip) : null;
  await db.$transaction(async (tx) => {
    if (ipHash) {
      // Serialise concurrent scans from the same visitor so the 60 second window is exact.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${q.id + ":" + ipHash}))`;
      const recent = await tx.qrScan.findFirst({
        where: { qrCodeId: q.id, ipHash, scannedAt: { gt: new Date(now.getTime() - SCAN_DEDUP_MS) } },
        select: { id: true },
      });
      if (recent) return;
    }
    await tx.qrScan.create({ data: { qrCodeId: q.id, ipHash, userAgentClass: uaClass(meta.userAgent), scannedAt: now } });
    await tx.qrCode.update({ where: { id: q.id }, data: { scanCount: { increment: 1 }, lastScannedAt: now } });
  });

  const { business: b } = q;
  return {
    state: "ok",
    qr: {
      id: q.id,
      token: q.token,
      type: q.type,
      label: q.label,
      productId: q.productId,
      orderId: q.orderId,
      fixedAmountMinor: q.fixedAmountMinor,
      allowCustomAmount: q.allowCustomAmount,
      minAmountMinor: q.minAmountMinor,
      maxAmountMinor: q.maxAmountMinor,
      expiresAt: q.expiresAt,
    },
    business: { id: b.id, name: b.name, logoFileId: b.logoFileId, currency: b.currency, acceptingOrders: b.acceptingOrders, pricesIncludeTax: b.pricesIncludeTax, defaultTaxBps: b.defaultTaxBps, hoursText: b.hoursText },
  };
}
