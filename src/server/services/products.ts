import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { db, type DbLike } from "@/lib/db";
import { audit } from "@/lib/audit";
import { AppError, badRequest, conflict, notFound } from "@/lib/errors";
import { pageQuery, skipTake, toPage } from "@/lib/pagination";
import { MAX_UNIT_PRICE_MINOR } from "@/lib/pricing";
import { amountMinorSchema, idSchema, optionalText, parse, taxBpsSchema } from "@/lib/validation";
import { assertBusinessAccess } from "@/server/auth/guards";
import type { Ctx } from "@/server/auth/types";
import { catalogActor, catalogScope } from "./categories";

const PERM = "products.manage";

const productName = z.string().trim().min(1, "Enter a name").max(120, "Keep it under 120 characters");

const base = {
  name: productName,
  description: optionalText(1000),
  kind: z.enum(["PRODUCT", "SERVICE"]),
  sku: optionalText(64),
  priceMinor: amountMinorSchema,
  taxBps: taxBpsSchema.nullable(),
  discountType: z.enum(["NONE", "PERCENT", "FIXED"]),
  discountValue: z.number().int().min(0),
  categoryId: idSchema.nullable(),
  imageFileId: idSchema.nullable(),
  isAvailable: z.boolean(),
  trackInventory: z.boolean(),
  stockQty: z.number().int().min(0).max(1_000_000),
};

const createSchema = z.object({
  businessId: idSchema,
  name: base.name,
  description: base.description,
  kind: base.kind.default("PRODUCT"),
  sku: base.sku,
  priceMinor: base.priceMinor,
  taxBps: base.taxBps.optional().transform((v) => v ?? null),
  discountType: base.discountType.default("NONE"),
  discountValue: base.discountValue.default(0),
  categoryId: base.categoryId.optional().transform((v) => v ?? null),
  imageFileId: base.imageFileId.optional().transform((v) => v ?? null),
  isAvailable: base.isAvailable.default(true),
  trackInventory: base.trackInventory.default(false),
  stockQty: base.stockQty.default(0),
});

const updateSchema = z.object({
  id: idSchema,
  name: base.name.optional(),
  description: z.union([base.description, z.null()]).optional(),
  kind: base.kind.optional(),
  sku: z.union([base.sku, z.null()]).optional(),
  priceMinor: base.priceMinor.optional(),
  taxBps: base.taxBps.optional(),
  discountType: base.discountType.optional(),
  discountValue: base.discountValue.optional(),
  categoryId: base.categoryId.optional(),
  imageFileId: base.imageFileId.optional(),
  isAvailable: base.isAvailable.optional(),
  trackInventory: base.trackInventory.optional(),
  stockQty: base.stockQty.optional(),
});

const listSchema = pageQuery.extend({
  businessId: idSchema.optional(),
  categoryId: z.union([idSchema, z.literal("none")]).optional(),
  kind: z.enum(["PRODUCT", "SERVICE"]).optional(),
  status: z.enum(["active", "available", "unavailable", "archived", "all"]).default("active"),
});

function checkDiscount(d: { priceMinor: number; discountType: string; discountValue: number }) {
  if (d.priceMinor > MAX_UNIT_PRICE_MINOR) throw badRequest("Price is too large");
  if (d.discountType === "PERCENT" && d.discountValue > 10000) {
    throw fieldError("discountValue", "Percent discount cannot exceed 100%");
  }
  if (d.discountType === "FIXED" && d.discountValue > d.priceMinor) {
    throw fieldError("discountValue", "Discount cannot be more than the price");
  }
}

function fieldError(field: string, msg: string) {
  return new AppError("VALIDATION", msg, { fields: { [field]: msg } });
}

async function assertCategoryInBusiness(categoryId: string | null | undefined, businessId: string) {
  if (!categoryId) return;
  const c = await db.productCategory.findUnique({ where: { id: categoryId }, select: { businessId: true } });
  if (!c || c.businessId !== businessId) {
    // Same answer whether the category does not exist or belongs to someone else.
    throw notFound("Category");
  }
}

async function assertImage(fileId: string | null | undefined) {
  if (!fileId) return;
  const f = await db.fileAsset.findUnique({ where: { id: fileId }, select: { contentType: true } });
  if (!f || !f.contentType.startsWith("image/")) throw notFound("Image");
}

async function assertSkuFree(tx: DbLike, businessId: string, sku: string | null | undefined, exceptId?: string) {
  if (!sku) return;
  const dup = await tx.product.findFirst({
    where: { businessId, sku: { equals: sku, mode: "insensitive" }, archivedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (dup) throw conflict("Another product already uses this SKU", { fields: { sku: "Already in use" } });
}

async function loadProduct(ctx: Ctx, id: string) {
  const p = await db.product.findUnique({ where: { id } });
  if (!p) throw notFound("Product");
  await assertBusinessAccess(ctx, p.businessId, PERM); // 404 when outside the actor's tenant
  return p;
}

export type ProductDto = Awaited<ReturnType<typeof getProduct>>;

function dto<T extends { imageFileId: string | null }>(p: T) {
  return { ...p, imageUrl: p.imageFileId ? `/api/files/${p.imageFileId}` : null };
}

export async function listProducts(ctx: Ctx, input: unknown = {}) {
  const q = parse(listSchema, input ?? {});
  const scope = await catalogScope(ctx, PERM, q.businessId);
  const where: Prisma.ProductWhereInput = { ...scope };
  if (q.status === "archived") where.archivedAt = { not: null };
  else {
    if (q.status !== "all") where.archivedAt = null;
    if (q.status === "available") where.isAvailable = true;
    if (q.status === "unavailable") where.isAvailable = false;
  }
  if (q.categoryId === "none") where.categoryId = null;
  else if (q.categoryId) where.categoryId = q.categoryId;
  if (q.kind) where.kind = q.kind;
  if (q.q) {
    where.OR = [
      { name: { contains: q.q, mode: "insensitive" } },
      { sku: { contains: q.q, mode: "insensitive" } },
      { description: { contains: q.q, mode: "insensitive" } },
    ];
  }
  const [rows, total] = await Promise.all([
    db.product.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      ...skipTake(q),
      include: { category: { select: { id: true, name: true } }, business: { select: { id: true, name: true, clientId: true } } },
    }),
    db.product.count({ where }),
  ]);
  return toPage(rows.map(dto), total, q);
}

export async function getProduct(ctx: Ctx, input: unknown) {
  catalogActor(ctx, PERM);
  const { id } = parse(z.object({ id: idSchema }), input);
  const p = await loadProduct(ctx, id);
  const full = await db.product.findUniqueOrThrow({
    where: { id: p.id },
    include: { category: { select: { id: true, name: true } }, business: { select: { id: true, name: true, clientId: true } } },
  });
  return dto(full);
}

export async function createProduct(ctx: Ctx, input: unknown) {
  const actor = catalogActor(ctx, PERM);
  const data = parse(createSchema, input);
  await assertBusinessAccess(ctx, data.businessId, PERM);
  if (data.discountType === "NONE") data.discountValue = 0;
  checkDiscount(data);
  await assertCategoryInBusiness(data.categoryId, data.businessId);
  await assertImage(data.imageFileId);
  if (!data.trackInventory) data.stockQty = 0;
  return db.$transaction(async (tx) => {
    await assertSkuFree(tx, data.businessId, data.sku);
    const p = await tx.product.create({ data });
    await audit(ctx, { action: "product.create", entityType: "Product", entityId: p.id, metadata: { businessId: p.businessId, name: p.name, priceMinor: p.priceMinor, by: actor.userId } }, tx);
    return dto(p);
  });
}

export async function updateProduct(ctx: Ctx, input: unknown) {
  catalogActor(ctx, PERM);
  const { id, ...patch } = parse(updateSchema, input);
  const existing = await loadProduct(ctx, id);
  if (existing.archivedAt) throw conflict("Restore this product before editing it");
  const merged = { ...existing, ...patch };
  if (merged.discountType === "NONE") merged.discountValue = 0;
  checkDiscount(merged);
  if (patch.categoryId !== undefined) await assertCategoryInBusiness(patch.categoryId, existing.businessId);
  if (patch.imageFileId !== undefined) await assertImage(patch.imageFileId);
  const data: Prisma.ProductUncheckedUpdateInput = { ...patch };
  data.discountValue = merged.discountValue;
  if (!merged.trackInventory) data.stockQty = 0;
  return db.$transaction(async (tx) => {
    if (patch.sku !== undefined) await assertSkuFree(tx, existing.businessId, patch.sku, id);
    const p = await tx.product.update({ where: { id }, data });
    await audit(ctx, { action: "product.update", entityType: "Product", entityId: id, metadata: { businessId: p.businessId, changed: Object.keys(patch) } }, tx);
    return dto(p);
  });
}

export async function setProductAvailability(ctx: Ctx, input: unknown) {
  catalogActor(ctx, PERM);
  const { id, isAvailable } = parse(z.object({ id: idSchema, isAvailable: z.boolean() }), input);
  const existing = await loadProduct(ctx, id);
  if (existing.archivedAt) throw conflict("Restore this product first");
  return db.$transaction(async (tx) => {
    const p = await tx.product.update({ where: { id }, data: { isAvailable } });
    await audit(ctx, { action: "product.availability", entityType: "Product", entityId: id, metadata: { businessId: p.businessId, isAvailable } }, tx);
    return dto(p);
  });
}

/** Soft delete. Products referenced by orders must keep existing, so archiving is the normal path. */
export async function archiveProduct(ctx: Ctx, input: unknown) {
  catalogActor(ctx, PERM);
  const { id } = parse(z.object({ id: idSchema }), input);
  const existing = await loadProduct(ctx, id);
  if (existing.archivedAt) return dto(existing);
  return db.$transaction(async (tx) => {
    const p = await tx.product.update({ where: { id }, data: { archivedAt: new Date(), isAvailable: false } });
    await audit(ctx, { action: "product.archive", entityType: "Product", entityId: id, metadata: { businessId: p.businessId, name: p.name } }, tx);
    return dto(p);
  });
}

export async function restoreProduct(ctx: Ctx, input: unknown) {
  catalogActor(ctx, PERM);
  const { id } = parse(z.object({ id: idSchema }), input);
  const existing = await loadProduct(ctx, id);
  if (!existing.archivedAt) return dto(existing);
  return db.$transaction(async (tx) => {
    await assertSkuFree(tx, existing.businessId, existing.sku, id);
    const p = await tx.product.update({ where: { id }, data: { archivedAt: null } });
    await audit(ctx, { action: "product.restore", entityType: "Product", entityId: id, metadata: { businessId: p.businessId } }, tx);
    return dto(p);
  });
}

/**
 * Permanent delete, only for products that no order has ever referenced.
 * Anything with order history is archived instead, so receipts keep their lines.
 */
export async function deleteProduct(ctx: Ctx, input: unknown) {
  catalogActor(ctx, PERM);
  const { id } = parse(z.object({ id: idSchema }), input);
  const existing = await loadProduct(ctx, id);
  return db.$transaction(async (tx) => {
    const used = await tx.orderItem.count({ where: { productId: id } });
    if (used > 0) {
      const p = await tx.product.update({ where: { id }, data: { archivedAt: existing.archivedAt ?? new Date(), isAvailable: false } });
      await audit(ctx, { action: "product.archive", entityType: "Product", entityId: id, metadata: { businessId: p.businessId, reason: "referenced by orders" } }, tx);
      return { deleted: false, archived: true };
    }
    await tx.product.delete({ where: { id } });
    await audit(ctx, { action: "product.delete", entityType: "Product", entityId: id, metadata: { businessId: existing.businessId, name: existing.name } }, tx);
    return { deleted: true, archived: false };
  });
}
