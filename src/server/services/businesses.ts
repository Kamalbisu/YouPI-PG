import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { badRequest, forbidden, notFound } from "@/lib/errors";
import { randomCode, withUniqueCode } from "@/lib/ids";
import { pageQuery, skipTake, toPage } from "@/lib/pagination";
import { emailSchema, idSchema, nameSchema, optionalPhone, optionalText, parse, pincodeSchema, taxBpsSchema } from "@/lib/validation";
import { assertBusinessAccess, businessScope, requireAdmin, requireClient } from "@/server/auth/guards";
import type { Ctx } from "@/server/auth/types";
import { saveImageAsset } from "./image-upload";
import { notifyAdmins, notifyBusinessUsers } from "./notifications";

const optionalEmail = z.union([emailSchema, z.literal("").transform(() => undefined)]).optional();
const optionalPincode = z.union([pincodeSchema, z.literal("").transform(() => undefined)]).optional();

/** Fields a client may set on its own business. Status, UPI id and ownership are deliberately absent. */
export const businessProfileInput = z.object({
  name: nameSchema,
  category: z.string().trim().min(2, "Too short").max(80),
  description: optionalText(1000),
  addressLine: optionalText(200),
  city: optionalText(80),
  state: optionalText(80),
  pincode: optionalPincode,
  contactPhone: optionalPhone,
  contactEmail: optionalEmail,
  ownerName: optionalText(120),
  ownerPhone: optionalPhone,
  hoursText: optionalText(300),
  acceptingOrders: z.boolean().default(true),
  pricesIncludeTax: z.boolean().default(false),
  defaultTaxBps: taxBpsSchema.default(0),
  allowCustomAmount: z.boolean().default(false),
});

const statusEnum = z.enum(["PENDING_APPROVAL", "ACTIVE", "SUSPENDED", "REJECTED", "INACTIVE"]);
const listInput = pageQuery.extend({
  status: statusEnum.optional().catch(undefined),
  clientId: idSchema.optional().catch(undefined),
});
const reasonSchema = z.object({ reason: z.string().trim().min(3, "Give a reason (at least 3 characters)").max(300) });

const LIST_SELECT = {
  id: true, businessCode: true, clientId: true, name: true, category: true, status: true, statusReason: true,
  acceptingOrders: true, city: true, createdAt: true, logoFileId: true,
} satisfies Prisma.BusinessSelect;

// ---------------------------------------------------------------------------
// Reads

/** Admin: all businesses, filterable. */
export async function listBusinesses(ctx: Ctx, raw: unknown) {
  requireAdmin(ctx);
  const q = parse(listInput, raw);
  const where: Prisma.BusinessWhereInput = {
    ...(q.status ? { status: q.status } : {}),
    ...(q.clientId ? { clientId: q.clientId } : {}),
    ...(q.q
      ? {
          OR: [
            { name: { contains: q.q, mode: "insensitive" } },
            { businessCode: { contains: q.q, mode: "insensitive" } },
            { client: { name: { contains: q.q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    db.business.findMany({ where, orderBy: { createdAt: "desc" }, ...skipTake(q), select: { ...LIST_SELECT, client: { select: { id: true, name: true, clientCode: true } } } }),
    db.business.count({ where }),
  ]);
  return toPage(items, total, q);
}

/** Client: the businesses the caller is a member of. */
export async function listMyBusinesses(ctx: Ctx) {
  requireClient(ctx);
  const scope = businessScope(ctx);
  return db.business.findMany({ where: { id: scope }, orderBy: { createdAt: "asc" }, select: LIST_SELECT });
}

/** Admin: any business. Client: only own, via membership (404 otherwise). */
export async function getBusiness(ctx: Ctx, id: string) {
  const base = await assertBusinessAccess(ctx, id);
  const full = await db.business.findUnique({
    where: { id: base.id },
    include: { client: { select: { id: true, name: true, clientCode: true, status: true, maxBusinesses: true } }, memberships: { select: { role: true, user: { select: { id: true, name: true, email: true, status: true } } } } },
  });
  if (!full) throw notFound("Business");
  const isAdmin = ctx.actor?.role === "SUPER_ADMIN";
  // Client users never see platform-controlled fields they cannot act on beyond status.
  return isAdmin ? full : { ...full, staticUpiVpa: undefined };
}

/** Rows used by the admin to know how many businesses a client may still add. */
export async function businessQuota(clientId: string) {
  const [client, used] = await Promise.all([
    db.client.findUnique({ where: { id: clientId }, select: { maxBusinesses: true } }),
    db.business.count({ where: { clientId, status: { not: "REJECTED" } } }),
  ]);
  return { used, max: client?.maxBusinesses ?? 0 };
}

// ---------------------------------------------------------------------------
// Client writes

/** Creates a business awaiting approval. Only the account owner (or a client with no businesses yet) may do this. */
export async function createBusiness(ctx: Ctx, raw: unknown) {
  const actor = requireClient(ctx);
  if (actor.businessIds.length > 0 && !actor.isOwner) throw forbidden("Only the account owner can add a business");
  const input = parse(businessProfileInput, raw);

  const business = await withUniqueCode(
    () => randomCode("BZ"),
    (businessCode) =>
      db.$transaction(async (tx) => {
        // Lock the client row so two concurrent requests cannot both pass the limit check.
        await tx.$queryRaw`SELECT id FROM clients WHERE id = ${actor.clientId} FOR UPDATE`;
        const client = await tx.client.findUnique({ where: { id: actor.clientId }, select: { maxBusinesses: true, status: true } });
        if (!client || client.status !== "ACTIVE") throw forbidden("This account is not active");
        const used = await tx.business.count({ where: { clientId: actor.clientId, status: { not: "REJECTED" } } });
        if (used >= client.maxBusinesses) {
          throw badRequest(`Your account is limited to ${client.maxBusinesses} ${client.maxBusinesses === 1 ? "business" : "businesses"}. Contact support to raise the limit.`, { code: "BUSINESS_LIMIT" });
        }
        const b = await tx.business.create({
          data: { ...input, businessCode, clientId: actor.clientId, currency: "INR", status: "PENDING_APPROVAL" },
        });
        await tx.businessMembership.create({ data: { userId: actor.userId, businessId: b.id, role: "OWNER" } });
        await audit(ctx, { action: "business.create", entityType: "Business", entityId: b.id, clientId: actor.clientId, metadata: { businessCode, name: b.name, category: b.category } }, tx);
        return b;
      }),
  );
  await notifyAdmins({ type: "business.pending", subject: "Business awaiting approval", body: `${business.name} (${business.businessCode}) was submitted for approval.`, link: `${process.env.APP_URL ?? ""}/admin/businesses/${business.id}` });
  return business;
}

export async function updateBusiness(ctx: Ctx, id: string, raw: unknown) {
  const before = await assertBusinessAccess(ctx, id, "settings.manage");
  const input = parse(businessProfileInput, raw);
  return db.$transaction(async (tx) => {
    const b = await tx.business.update({
      where: { id: before.id },
      data: {
        name: input.name, category: input.category,
        description: input.description ?? null, addressLine: input.addressLine ?? null, city: input.city ?? null, state: input.state ?? null,
        pincode: input.pincode ?? null, contactPhone: input.contactPhone ?? null, contactEmail: input.contactEmail ?? null,
        ownerName: input.ownerName ?? null, ownerPhone: input.ownerPhone ?? null, hoursText: input.hoursText ?? null,
        acceptingOrders: input.acceptingOrders, pricesIncludeTax: input.pricesIncludeTax, defaultTaxBps: input.defaultTaxBps, allowCustomAmount: input.allowCustomAmount,
        currency: "INR",
      },
    });
    const changed = (Object.keys(input) as (keyof typeof input)[]).filter((k) => (input[k] ?? null) !== ((before as Record<string, unknown>)[k] ?? null));
    await audit(ctx, { action: "business.update", entityType: "Business", entityId: b.id, clientId: b.clientId, metadata: { changed } }, tx);
    return b;
  });
}

export async function setBusinessLogo(ctx: Ctx, id: string, file: File) {
  const business = await assertBusinessAccess(ctx, id, "settings.manage");
  const { id: fileId } = await saveImageAsset(file, ctx.actor!.userId);
  return db.$transaction(async (tx) => {
    const b = await tx.business.update({ where: { id: business.id }, data: { logoFileId: fileId } });
    if (business.logoFileId) {
      await tx.fileAsset.deleteMany({ where: { id: business.logoFileId, businessLogos: { none: {} }, productImages: { none: {} } } });
    }
    await audit(ctx, { action: "business.logo_set", entityType: "Business", entityId: b.id, clientId: b.clientId, metadata: { fileId } }, tx);
    return { logoFileId: b.logoFileId };
  });
}

export async function removeBusinessLogo(ctx: Ctx, id: string) {
  const business = await assertBusinessAccess(ctx, id, "settings.manage");
  if (!business.logoFileId) return { logoFileId: null };
  return db.$transaction(async (tx) => {
    await tx.business.update({ where: { id: business.id }, data: { logoFileId: null } });
    await tx.fileAsset.deleteMany({ where: { id: business.logoFileId!, businessLogos: { none: {} }, productImages: { none: {} } } });
    await audit(ctx, { action: "business.logo_remove", entityType: "Business", entityId: business.id, clientId: business.clientId }, tx);
    return { logoFileId: null };
  });
}

// ---------------------------------------------------------------------------
// Admin lifecycle

type Transition = { action: string; from: string[]; to: "ACTIVE" | "REJECTED" | "SUSPENDED"; needsReason: boolean; verb: string };

const TRANSITIONS: Record<"approve" | "reject" | "suspend" | "reactivate", Transition> = {
  approve: { action: "business.approve", from: ["PENDING_APPROVAL", "REJECTED"], to: "ACTIVE", needsReason: false, verb: "approved" },
  reject: { action: "business.reject", from: ["PENDING_APPROVAL"], to: "REJECTED", needsReason: true, verb: "rejected" },
  suspend: { action: "business.suspend", from: ["ACTIVE"], to: "SUSPENDED", needsReason: true, verb: "suspended" },
  reactivate: { action: "business.reactivate", from: ["SUSPENDED", "INACTIVE"], to: "ACTIVE", needsReason: false, verb: "reactivated" },
};

async function transition(ctx: Ctx, id: string, kind: keyof typeof TRANSITIONS, raw: unknown) {
  requireAdmin(ctx);
  const t = TRANSITIONS[kind];
  const { reason } = t.needsReason ? parse(reasonSchema, raw ?? {}) : parse(z.object({ reason: optionalText(300) }), raw ?? {});
  const parsedId = idSchema.safeParse(id);
  const before = parsedId.success ? await db.business.findUnique({ where: { id: parsedId.data } }) : null;
  if (!before) throw notFound("Business");
  if (!t.from.includes(before.status)) throw badRequest(`A business that is ${before.status.toLowerCase().replace("_", " ")} cannot be ${t.verb}`);
  const business = await db.$transaction(async (tx) => {
    // Conditional update so two admins acting at once cannot both apply a transition.
    const r = await tx.business.updateMany({
      where: { id: before.id, status: before.status },
      data: { status: t.to, statusReason: t.needsReason ? reason : null },
    });
    if (r.count !== 1) throw badRequest("The business changed while you were working. Reload and try again.");
    await audit(ctx, { action: t.action, entityType: "Business", entityId: before.id, clientId: before.clientId, metadata: { from: before.status, to: t.to, reason } }, tx);
    return tx.business.findUniqueOrThrow({ where: { id: before.id } });
  });
  await notifyBusinessUsers(business.id, {
    type: `business.${kind}`,
    subject: `Your business ${business.name} was ${t.verb}`,
    body: reason ? `${business.name} was ${t.verb}. Reason: ${reason}` : `${business.name} was ${t.verb}.`,
    link: `${process.env.APP_URL ?? ""}/client/businesses/${business.id}`,
  });
  return business;
}

export const approveBusiness = (ctx: Ctx, id: string, raw?: unknown) => transition(ctx, id, "approve", raw);
export const rejectBusiness = (ctx: Ctx, id: string, raw: unknown) => transition(ctx, id, "reject", raw);
export const suspendBusiness = (ctx: Ctx, id: string, raw: unknown) => transition(ctx, id, "suspend", raw);
export const reactivateBusiness = (ctx: Ctx, id: string, raw?: unknown) => transition(ctx, id, "reactivate", raw);
