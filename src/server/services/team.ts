import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { badRequest, conflict, notFound } from "@/lib/errors";
import { emailSchema, idSchema, nameSchema, optionalPhone, parse } from "@/lib/validation";
import { assertBusinessAccess, requireClient } from "@/server/auth/guards";
import { revokeAllSessions } from "@/server/auth/session";
import type { Ctx } from "@/server/auth/types";
import { issueToken } from "./auth";
import { notify } from "./notifications";

const addInput = z.object({ name: nameSchema, email: emailSchema, phone: optionalPhone });

/** Team management is OWNER-only (the "team.manage" permission is owner-only in the guards). */
async function guard(ctx: Ctx, businessId: string) {
  requireClient(ctx, "team.manage");
  return assertBusinessAccess(ctx, businessId, "team.manage");
}

export async function listTeam(ctx: Ctx, businessId: string) {
  const business = await guard(ctx, businessId);
  const rows = await db.businessMembership.findMany({
    where: { businessId: business.id },
    orderBy: { createdAt: "asc" },
    select: { role: true, createdAt: true, user: { select: { id: true, name: true, email: true, phone: true, status: true, lastLoginAt: true } } },
  });
  return rows.map((r) => ({ role: r.role, addedAt: r.createdAt, ...r.user }));
}

/** Adds a MANAGER who can see only this business. They set their own password through an invite link. */
export async function addTeamMember(ctx: Ctx, businessId: string, raw: unknown) {
  const business = await guard(ctx, businessId);
  const input = parse(addInput, raw);
  if (await db.user.findUnique({ where: { email: input.email }, select: { id: true } })) {
    throw conflict("An account with this email already exists", { fields: { email: "An account with this email already exists" } });
  }
  const user = await db
    .$transaction(async (tx) => {
      const u = await tx.user.create({
        data: { email: input.email, name: input.name, phone: input.phone, role: "CLIENT", status: "INVITED", clientId: business.clientId },
      });
      await tx.businessMembership.create({ data: { userId: u.id, businessId: business.id, role: "MANAGER" } });
      await audit(ctx, { action: "team.add", entityType: "Business", entityId: business.id, clientId: business.clientId, metadata: { memberId: u.id, email: u.email, role: "MANAGER" } }, tx);
      return u;
    })
    .catch(async (e) => {
      if ((e as { code?: string })?.code === "P2002") throw conflict("An account with this email already exists", { fields: { email: "An account with this email already exists" } });
      throw e;
    });
  const { link } = await issueToken(user.id, "INVITE");
  const { emailStatus } = await notify({
    userId: user.id,
    to: user.email,
    type: "team.invite",
    subject: `You were added to ${business.name} on YouPI PG`,
    body: `Hello ${user.name}, you have been added as a manager of ${business.name}. Use the link below to set your password. The link works for 7 days and can be used once.`,
    link,
  });
  // The link goes back to the owner who asked (useful when email is not configured); it is never logged or audited.
  return { member: { id: user.id, name: user.name, email: user.email, role: "MANAGER" as const }, inviteLink: link, emailStatus };
}

/** Re-issues the invite for a manager who has not set a password yet. */
export async function resendTeamInvite(ctx: Ctx, businessId: string, userId: string) {
  const business = await guard(ctx, businessId);
  const m = await db.businessMembership.findFirst({ where: { businessId: business.id, userId: idSchema.parse(userId) }, include: { user: true } });
  if (!m) throw notFound("Team member");
  if (m.user.status !== "INVITED") throw badRequest("This person has already set a password");
  const { link } = await issueToken(m.user.id, "INVITE");
  const { emailStatus } = await notify({
    userId: m.user.id, to: m.user.email, type: "team.invite", subject: `You were added to ${business.name} on YouPI PG`,
    body: `Hello ${m.user.name}, use the link below to set your password. The link works for 7 days and can be used once.`, link,
  });
  await audit(ctx, { action: "team.invite_resend", entityType: "Business", entityId: business.id, clientId: business.clientId, metadata: { memberId: m.user.id } });
  return { inviteLink: link, emailStatus };
}

/** Removes a MANAGER from this business. Owners cannot be removed here. */
export async function removeTeamMember(ctx: Ctx, businessId: string, userId: string) {
  const business = await guard(ctx, businessId);
  const m = await db.businessMembership.findFirst({ where: { businessId: business.id, userId: idSchema.parse(userId) } });
  if (!m) throw notFound("Team member");
  if (m.role === "OWNER") throw badRequest("The business owner cannot be removed");
  const stillMember = await db.$transaction(async (tx) => {
    await tx.businessMembership.delete({ where: { id: m.id } });
    const remaining = await tx.businessMembership.count({ where: { userId: m.userId } });
    // A manager with no business left has nothing to do here: disable the login.
    if (remaining === 0) await tx.user.update({ where: { id: m.userId }, data: { status: "INACTIVE" } });
    await audit(ctx, { action: "team.remove", entityType: "Business", entityId: business.id, clientId: business.clientId, metadata: { memberId: m.userId } }, tx);
    return remaining > 0;
  });
  // Sessions cache nothing about businesses, but a disabled user must be signed out immediately.
  if (!stillMember) await revokeAllSessions(m.userId);
  return { removed: true };
}
