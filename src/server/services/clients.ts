import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { conflict, notFound, badRequest } from "@/lib/errors";
import { randomCode, withUniqueCode } from "@/lib/ids";
import { pageQuery, skipTake, toPage } from "@/lib/pagination";
import { ALL_CLIENT_PERMISSIONS } from "@/lib/permissions";
import { emailSchema, idSchema, nameSchema, optionalPhone, optionalText, parse } from "@/lib/validation";
import { requireAdmin } from "@/server/auth/guards";
import type { Ctx } from "@/server/auth/types";
import { issueToken } from "./auth";
import { notify } from "./notifications";
import { getSetting } from "./settings";

const permissionsSchema = z
  .array(z.enum(ALL_CLIENT_PERMISSIONS as [string, ...string[]], { message: "Unknown permission" }))
  .transform((a) => Array.from(new Set(a)));

const maxBusinessesSchema = z.coerce.number().int("Whole number").min(1, "At least 1").max(100, "At most 100");

export const createClientInput = z.object({
  name: nameSchema,
  contactName: nameSchema,
  email: emailSchema,
  phone: optionalPhone,
  address: optionalText(300),
  notes: optionalText(1000),
  permissions: permissionsSchema.optional(),
  maxBusinesses: maxBusinessesSchema.default(1),
});

export const updateClientInput = z.object({
  name: nameSchema,
  contactName: nameSchema,
  phone: optionalPhone,
  address: optionalText(300),
  notes: optionalText(1000),
  maxBusinesses: maxBusinessesSchema,
});

const clientStatusFilter = z.enum(["ACTIVE", "INACTIVE", "SUSPENDED"]);
const listInput = pageQuery.extend({ status: clientStatusFilter.optional().catch(undefined) });
const reasonSchema = z.object({ reason: z.string().trim().min(3, "Give a reason (at least 3 characters)").max(300) });

async function loadClient(id: string) {
  const parsed = idSchema.safeParse(id);
  const c = parsed.success ? await db.client.findUnique({ where: { id: parsed.data } }) : null;
  if (!c) throw notFound("Client");
  return c;
}

/** The first user created for a client (the account holder), the target of invites and resets. */
async function primaryUser(clientId: string) {
  return db.user.findFirst({ where: { clientId, role: "CLIENT" }, orderBy: { createdAt: "asc" } });
}

export async function listClients(ctx: Ctx, raw: unknown) {
  requireAdmin(ctx);
  const q = parse(listInput, raw);
  const where: Prisma.ClientWhereInput = {
    ...(q.status ? { status: q.status } : {}),
    ...(q.q
      ? {
          OR: [
            { name: { contains: q.q, mode: "insensitive" } },
            { contactName: { contains: q.q, mode: "insensitive" } },
            { email: { contains: q.q, mode: "insensitive" } },
            { clientCode: { contains: q.q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    db.client.findMany({ where, orderBy: { createdAt: "desc" }, ...skipTake(q), include: { _count: { select: { businesses: true, users: true } } } }),
    db.client.count({ where }),
  ]);
  return toPage(items, total, q);
}

/** Creates the client and its account-holder user, then emails a set-password invite. */
export async function createClient(ctx: Ctx, raw: unknown) {
  requireAdmin(ctx);
  const input = parse(createClientInput, raw);
  const permissions = input.permissions ?? (await getSetting("defaultClientPermissions"));

  // Checked up front: a unique-index error inside the transaction would abort it and be mistaken for a code clash.
  if (await db.user.findUnique({ where: { email: input.email }, select: { id: true } })) {
    throw conflict("An account with this email already exists", { fields: { email: "An account with this email already exists" } });
  }

  let created;
  try {
    created = await withUniqueCode(
      () => randomCode("CL"),
      (clientCode) =>
        db.$transaction(async (tx) => {
          const client = await tx.client.create({
            data: {
              clientCode,
              name: input.name,
              contactName: input.contactName,
              email: input.email,
              phone: input.phone,
              address: input.address,
              notes: input.notes,
              permissions,
              maxBusinesses: input.maxBusinesses,
            },
          });
          const user = await tx.user.create({
            data: { email: input.email, name: input.contactName, phone: input.phone, role: "CLIENT", status: "INVITED", clientId: client.id },
          });
          await audit(
            ctx,
            { action: "client.create", entityType: "Client", entityId: client.id, clientId: client.id, metadata: { clientCode, name: client.name, email: client.email, permissions, maxBusinesses: client.maxBusinesses } },
            tx,
          );
          return { client, user };
        }),
    );
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002" && (await db.user.findUnique({ where: { email: input.email }, select: { id: true } }))) {
      throw conflict("An account with this email already exists", { fields: { email: "An account with this email already exists" } });
    }
    throw e;
  }

  const { link } = await issueToken(created.user.id, "INVITE");
  const { emailStatus } = await notify({
    userId: created.user.id,
    to: created.user.email,
    type: "client.invite",
    subject: "You have been invited to YouPI PG",
    body: `Hello ${created.user.name}, an account has been created for ${created.client.name}. Use the link below to set your password. The link works for 7 days and can be used once.`,
    link,
  });
  // The link is returned to the admin only (for the case where email is not configured). It is never logged or audited.
  return { client: created.client, user: { id: created.user.id, email: created.user.email, name: created.user.name }, inviteLink: link, emailStatus };
}

export async function getClient(ctx: Ctx, id: string) {
  requireAdmin(ctx);
  const client = await loadClient(id);
  const [users, businesses, suspension] = await Promise.all([
    db.user.findMany({
      where: { clientId: client.id },
      orderBy: { createdAt: "asc" },
      select: {
        id: true, email: true, name: true, phone: true, status: true, totpEnabled: true, lastLoginAt: true, createdAt: true,
        memberships: { select: { role: true, business: { select: { id: true, name: true } } } },
      },
    }),
    db.business.findMany({
      where: { clientId: client.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, businessCode: true, name: true, category: true, status: true, createdAt: true },
    }),
    client.status === "ACTIVE"
      ? Promise.resolve(null)
      : db.auditLog.findFirst({ where: { entityType: "Client", entityId: client.id, action: "client.suspend" }, orderBy: { createdAt: "desc" } }),
  ]);
  const reason = (suspension?.metadata as { reason?: string } | null)?.reason ?? null;
  return { client, users, businesses, suspension: suspension ? { reason, at: suspension.createdAt } : null };
}

export async function updateClient(ctx: Ctx, id: string, raw: unknown) {
  requireAdmin(ctx);
  const input = parse(updateClientInput, raw);
  const before = await loadClient(id);
  return db.$transaction(async (tx) => {
    const client = await tx.client.update({
      where: { id: before.id },
      data: { name: input.name, contactName: input.contactName, phone: input.phone ?? null, address: input.address ?? null, notes: input.notes ?? null, maxBusinesses: input.maxBusinesses },
    });
    await audit(
      ctx,
      {
        action: "client.update", entityType: "Client", entityId: client.id, clientId: client.id,
        metadata: { from: { name: before.name, contactName: before.contactName, maxBusinesses: before.maxBusinesses }, to: { name: client.name, contactName: client.contactName, maxBusinesses: client.maxBusinesses } },
      },
      tx,
    );
    return client;
  });
}

export async function updateClientPermissions(ctx: Ctx, id: string, raw: unknown) {
  requireAdmin(ctx);
  const { permissions } = parse(z.object({ permissions: permissionsSchema }), raw);
  const before = await loadClient(id);
  return db.$transaction(async (tx) => {
    const client = await tx.client.update({ where: { id: before.id }, data: { permissions } });
    await audit(ctx, { action: "client.permissions", entityType: "Client", entityId: client.id, clientId: client.id, metadata: { from: before.permissions, to: permissions } }, tx);
    return client;
  });
}

export async function suspendClient(ctx: Ctx, id: string, raw: unknown) {
  requireAdmin(ctx);
  const { reason } = parse(reasonSchema, raw);
  const before = await loadClient(id);
  if (before.status === "SUSPENDED") throw badRequest("This client is already suspended");
  const users = await db.user.findMany({ where: { clientId: before.id }, select: { id: true, email: true } });
  const client = await db.$transaction(async (tx) => {
    const c = await tx.client.update({ where: { id: before.id }, data: { status: "SUSPENDED" } });
    await tx.session.updateMany({ where: { userId: { in: users.map((u) => u.id) }, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(ctx, { action: "client.suspend", entityType: "Client", entityId: c.id, clientId: c.id, metadata: { reason, from: before.status, sessionsRevokedFor: users.length } }, tx);
    return c;
  });
  for (const u of users) {
    await notify({ userId: u.id, to: u.email, type: "client.suspended", subject: "Your YouPI PG account has been suspended", body: `Your account for ${client.name} has been suspended. Reason: ${reason}. Contact support if you think this is a mistake.` });
  }
  return client;
}

export async function reactivateClient(ctx: Ctx, id: string, raw: unknown) {
  requireAdmin(ctx);
  const { reason } = parse(z.object({ reason: optionalText(300) }), raw ?? {});
  const before = await loadClient(id);
  if (before.status === "ACTIVE") throw badRequest("This client is already active");
  const client = await db.$transaction(async (tx) => {
    const c = await tx.client.update({ where: { id: before.id }, data: { status: "ACTIVE" } });
    await audit(ctx, { action: "client.reactivate", entityType: "Client", entityId: c.id, clientId: c.id, metadata: { reason, from: before.status } }, tx);
    return c;
  });
  const users = await db.user.findMany({ where: { clientId: before.id, status: "ACTIVE" }, select: { id: true, email: true } });
  for (const u of users) {
    await notify({ userId: u.id, to: u.email, type: "client.reactivated", subject: "Your YouPI PG account is active again", body: `Your account for ${client.name} has been reactivated. You can sign in again.` });
  }
  return client;
}

/**
 * Admin-initiated reset. Issues a one-time link (a fresh invite if the person never set a password),
 * signs the user out everywhere, and emails them. The link is returned to the admin only.
 */
export async function resetClientPassword(ctx: Ctx, id: string, raw: unknown) {
  requireAdmin(ctx);
  const { userId } = parse(z.object({ userId: idSchema.optional() }), raw ?? {});
  const client = await loadClient(id);
  const user = userId ? await db.user.findFirst({ where: { id: userId, clientId: client.id } }) : await primaryUser(client.id);
  if (!user) throw notFound("User");
  const invite = user.status === "INVITED";
  const { link } = await issueToken(user.id, invite ? "INVITE" : "PASSWORD_RESET");
  await db.$transaction(async (tx) => {
    await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(ctx, { action: invite ? "client.invite_resend" : "client.password_reset", entityType: "User", entityId: user.id, clientId: client.id, metadata: { email: user.email } }, tx);
  });
  const { emailStatus } = await notify({
    userId: user.id,
    to: user.email,
    type: invite ? "client.invite" : "auth.password_reset",
    subject: invite ? "You have been invited to YouPI PG" : "Reset your YouPI PG password",
    body: invite ? "Use the link below to set your password. It works for 7 days and can be used once." : "An administrator started a password reset for your account. The link works for 1 hour and can be used once.",
    link,
  });
  return { link, purpose: invite ? ("INVITE" as const) : ("PASSWORD_RESET" as const), user: { id: user.id, email: user.email }, emailStatus };
}

export async function clientLoginActivity(ctx: Ctx, id: string, raw: unknown) {
  requireAdmin(ctx);
  const q = parse(pageQuery, raw ?? {});
  const client = await loadClient(id);
  const users = await db.user.findMany({ where: { clientId: client.id }, select: { id: true, email: true } });
  const where: Prisma.LoginEventWhereInput = { OR: [{ userId: { in: users.map((u) => u.id) } }, { email: { in: users.map((u) => u.email) } }] };
  const [items, total] = await Promise.all([db.loginEvent.findMany({ where, orderBy: { createdAt: "desc" }, ...skipTake(q) }), db.loginEvent.count({ where })]);
  return toPage(items, total, q);
}

