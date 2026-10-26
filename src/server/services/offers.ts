import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { db, type DbLike } from "@/lib/db";
import { audit } from "@/lib/audit";
import { AppError, conflict, notFound } from "@/lib/errors";
import { pageQuery, skipTake, toPage } from "@/lib/pagination";
import { idSchema, optionalText, parse } from "@/lib/validation";
import { assertBusinessAccess } from "@/server/auth/guards";
import type { Ctx } from "@/server/auth/types";
import { catalogActor, catalogScope } from "./categories";

const PERM = "offers.manage";

const code = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9_-]{3,24}$/, "Use 3 to 24 letters, numbers, dashes or underscores"));

const date = z
  .union([z.string().trim().min(1), z.date()])
  .transform((v, ctx) => {
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: "custom", message: "Enter a valid date" });
      return z.NEVER;
    }
    return d;
  });

const fields = {
  title: z.string().trim().min(2, "Enter a title").max(80),
  description: optionalText(300),
  code,
  type: z.enum(["PERCENT", "FIXED"]),
  value: z.number().int().min(1, "Enter a value above zero").max(10_000_000_00),
  minOrderMinor: z.number().int().min(0).max(10_000_000_00),
  maxDiscountMinor: z.number().int().min(1).max(10_000_000_00).nullable(),
  validFrom: date.nullable(),
  validTo: date.nullable(),
  usageLimit: z.number().int().min(1).max(10_000_000).nullable(),
  isActive: z.boolean(),
};

const createSchema = z.object({
  businessId: idSchema,
  title: fields.title,
  description: fields.description,
  code: fields.code,
  type: fields.type,
  value: fields.value,
  minOrderMinor: fields.minOrderMinor.default(0),
  maxDiscountMinor: fields.maxDiscountMinor.optional().transform((v) => v ?? null),
  validFrom: fields.validFrom.optional().transform((v) => v ?? null),
  validTo: fields.validTo.optional().transform((v) => v ?? null),
  usageLimit: fields.usageLimit.optional().transform((v) => v ?? null),
  isActive: fields.isActive.default(true),
});

const updateSchema = z.object({
  id: idSchema,
  title: fields.title.optional(),
  description: z.union([fields.description, z.null()]).optional(),
  code: fields.code.optional(),
  type: fields.type.optional(),
  value: fields.value.optional(),
  minOrderMinor: fields.minOrderMinor.optional(),
  maxDiscountMinor: fields.maxDiscountMinor.optional(),
  validFrom: fields.validFrom.optional(),
  validTo: fields.validTo.optional(),
  usageLimit: fields.usageLimit.optional(),
  isActive: fields.isActive.optional(),
});

const listSchema = pageQuery.extend({
  businessId: idSchema.optional(),
  status: z.enum(["all", "active", "inactive", "expired"]).default("all"),
});

const bad = (field: string, msg: string) => new AppError("VALIDATION", msg, { fields: { [field]: msg } });

function checkRules(o: { type: string; value: number; validFrom: Date | null; validTo: Date | null; usageLimit: number | null; usedCount?: number }) {
  if (o.type === "PERCENT" && o.value > 10000) throw bad("value", "Percent discount cannot exceed 100%");
  if (o.validFrom && o.validTo && o.validTo.getTime() < o.validFrom.getTime()) throw bad("validTo", "End date must be after the start date");
  if (o.usageLimit !== null && o.usedCount !== undefined && o.usageLimit < o.usedCount) {
    throw bad("usageLimit", `Already used ${o.usedCount} times`);
  }
}

async function loadOffer(ctx: Ctx, id: string) {
  const o = await db.offer.findUnique({ where: { id } });
  if (!o) throw notFound("Offer");
  await assertBusinessAccess(ctx, o.businessId, PERM);
  return o;
}

export async function listOffers(ctx: Ctx, input: unknown = {}) {
  const q = parse(listSchema, input ?? {});
  const scope = await catalogScope(ctx, PERM, q.businessId);
  const now = new Date();
  const where: Prisma.OfferWhereInput = { ...scope };
  if (q.status === "active") Object.assign(where, { isActive: true, OR: [{ validTo: null }, { validTo: { gte: now } }] });
  if (q.status === "inactive") where.isActive = false;
  if (q.status === "expired") where.validTo = { lt: now };
  if (q.q) {
    const search = [{ title: { contains: q.q, mode: "insensitive" as const } }, { code: { contains: q.q.toUpperCase() } }];
    where.AND = [{ OR: search }];
  }
  const [rows, total] = await Promise.all([
    db.offer.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      ...skipTake(q),
      include: { business: { select: { id: true, name: true } } },
    }),
    db.offer.count({ where }),
  ]);
  return toPage(rows, total, q);
}

export async function createOffer(ctx: Ctx, input: unknown) {
  catalogActor(ctx, PERM);
  const data = parse(createSchema, input);
  await assertBusinessAccess(ctx, data.businessId, PERM);
  checkRules(data);
  return db.$transaction(async (tx) => {
    const dup = await tx.offer.findUnique({ where: { businessId_code: { businessId: data.businessId, code: data.code } } });
    if (dup) throw conflict("This coupon code is already in use", { fields: { code: "Already in use" } });
    const o = await tx.offer.create({ data });
    await audit(ctx, { action: "offer.create", entityType: "Offer", entityId: o.id, metadata: { businessId: o.businessId, couponCode: o.code, type: o.type, value: o.value } }, tx);
    return o;
  });
}

export async function updateOffer(ctx: Ctx, input: unknown) {
  catalogActor(ctx, PERM);
  const { id, ...patch } = parse(updateSchema, input);
  const existing = await loadOffer(ctx, id);
  checkRules({ ...existing, ...patch });
  return db.$transaction(async (tx) => {
    if (patch.code && patch.code !== existing.code) {
      const dup = await tx.offer.findUnique({ where: { businessId_code: { businessId: existing.businessId, code: patch.code } } });
      if (dup) throw conflict("This coupon code is already in use", { fields: { code: "Already in use" } });
    }
    const o = await tx.offer.update({ where: { id }, data: patch });
    await audit(ctx, { action: "offer.update", entityType: "Offer", entityId: id, metadata: { businessId: o.businessId, changed: Object.keys(patch) } }, tx);
    return o;
  });
}

/** Offers that orders already used are deactivated rather than removed, so order history stays intact. */
export async function deleteOffer(ctx: Ctx, input: unknown) {
  catalogActor(ctx, PERM);
  const { id } = parse(z.object({ id: idSchema }), input);
  const existing = await loadOffer(ctx, id);
  return db.$transaction(async (tx) => {
    const used = await tx.order.count({ where: { offerId: id } });
    if (used > 0) {
      await tx.offer.update({ where: { id }, data: { isActive: false } });
      await audit(ctx, { action: "offer.deactivate", entityType: "Offer", entityId: id, metadata: { businessId: existing.businessId, reason: "used by orders" } }, tx);
      return { deleted: false, deactivated: true };
    }
    await tx.offer.delete({ where: { id } });
    await audit(ctx, { action: "offer.delete", entityType: "Offer", entityId: id, metadata: { businessId: existing.businessId, couponCode: existing.code } }, tx);
    return { deleted: true, deactivated: false };
  });
}

/** Internal lookup for checkout (no actor): the offer row for a coupon code of one business, or null. */
export async function findOfferByCode(businessId: string, rawCode: string, tx: DbLike = db) {
  const c = rawCode.trim().toUpperCase();
  if (!c) return null;
  return tx.offer.findUnique({ where: { businessId_code: { businessId, code: c } } });
}
