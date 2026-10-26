import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { conflict, notFound } from "@/lib/errors";
import { idSchema, parse } from "@/lib/validation";
import { assertBusinessAccess, businessScope, requireActor, requireClient } from "@/server/auth/guards";
import type { Actor, Ctx } from "@/server/auth/types";

/** Permission gate shared by the catalog services: admins pass, clients need the capability. Runs before any DB access. */
export function catalogActor(ctx: Ctx, permission: string): Actor {
  const a = requireActor(ctx);
  if (a.role === "CLIENT") requireClient(ctx, permission);
  return a;
}

/**
 * Where-clause for listing business-owned rows. A given businessId is checked with
 * assertBusinessAccess (out of tenant -> 404); otherwise clients are limited to their businesses.
 */
export async function catalogScope(ctx: Ctx, permission: string, businessId?: string): Promise<{ businessId?: string | { in: string[] } }> {
  catalogActor(ctx, permission);
  if (businessId) {
    await assertBusinessAccess(ctx, businessId, permission);
    return { businessId };
  }
  const scope = businessScope(ctx);
  return scope ? { businessId: scope } : {};
}

const PERM = "products.manage";

const categoryName = z.string().trim().min(1, "Enter a name").max(60, "Keep it under 60 characters");

const createSchema = z.object({
  businessId: idSchema,
  name: categoryName,
  sortOrder: z.number().int().min(0).max(10000).default(0),
});

const updateSchema = z.object({
  id: idSchema,
  name: categoryName.optional(),
  sortOrder: z.number().int().min(0).max(10000).optional(),
});

const listSchema = z.object({ businessId: idSchema.optional() });

async function loadCategory(ctx: Ctx, id: string) {
  const row = await db.productCategory.findUnique({ where: { id } });
  if (!row) throw notFound("Category");
  await assertBusinessAccess(ctx, row.businessId, PERM); // 404 when outside the actor's tenant
  return row;
}

export async function listCategories(ctx: Ctx, input: unknown = {}) {
  const q = parse(listSchema, input ?? {});
  const where = await catalogScope(ctx, PERM, q.businessId);
  const rows = await db.productCategory.findMany({
    where,
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { _count: { select: { products: { where: { archivedAt: null } } } }, business: { select: { name: true } } },
  });
  return rows.map((c) => ({ id: c.id, businessId: c.businessId, businessName: c.business.name, name: c.name, sortOrder: c.sortOrder, productCount: c._count.products }));
}

export async function createCategory(ctx: Ctx, input: unknown) {
  catalogActor(ctx, PERM);
  const data = parse(createSchema, input);
  await assertBusinessAccess(ctx, data.businessId, PERM);
  const dup = await db.productCategory.findUnique({ where: { businessId_name: { businessId: data.businessId, name: data.name } } });
  if (dup) throw conflict("A category with this name already exists", { fields: { name: "Already exists" } });
  return db.$transaction(async (tx) => {
    const c = await tx.productCategory.create({ data });
    await audit(ctx, { action: "category.create", entityType: "ProductCategory", entityId: c.id, metadata: { businessId: c.businessId, name: c.name } }, tx);
    return c;
  });
}

export async function updateCategory(ctx: Ctx, input: unknown) {
  catalogActor(ctx, PERM);
  const { id, ...patch } = parse(updateSchema, input);
  const existing = await loadCategory(ctx, id);
  if (patch.name && patch.name !== existing.name) {
    const dup = await db.productCategory.findUnique({ where: { businessId_name: { businessId: existing.businessId, name: patch.name } } });
    if (dup) throw conflict("A category with this name already exists", { fields: { name: "Already exists" } });
  }
  return db.$transaction(async (tx) => {
    const c = await tx.productCategory.update({ where: { id }, data: patch });
    await audit(ctx, { action: "category.update", entityType: "ProductCategory", entityId: id, metadata: { businessId: c.businessId, changed: Object.keys(patch) } }, tx);
    return c;
  });
}

/** Deleting a category keeps its products (they become uncategorised). */
export async function deleteCategory(ctx: Ctx, input: unknown) {
  catalogActor(ctx, PERM);
  const { id } = parse(z.object({ id: idSchema }), input);
  const existing = await loadCategory(ctx, id);
  return db.$transaction(async (tx) => {
    const affected = await tx.product.count({ where: { categoryId: id } });
    await tx.productCategory.delete({ where: { id } });
    await audit(ctx, { action: "category.delete", entityType: "ProductCategory", entityId: id, metadata: { businessId: existing.businessId, name: existing.name, productsUncategorised: affected } }, tx);
    return { ok: true, productsUncategorised: affected };
  });
}
