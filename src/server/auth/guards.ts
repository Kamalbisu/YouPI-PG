import { db } from "@/lib/db";
import { AppError, forbidden, notFound, unauthenticated } from "@/lib/errors";
import type { Actor, Ctx } from "./types";

/** Capabilities only an owner (not a manager) may use, even if granted to the client. */
const OWNER_ONLY = new Set(["team.manage", "settings.manage", "payments.refund"]);

export function requireActor(ctx: Ctx): Actor {
  if (!ctx.actor) throw unauthenticated();
  return ctx.actor;
}

export function requireAdmin(ctx: Ctx): Actor {
  const a = requireActor(ctx);
  if (a.role !== "SUPER_ADMIN") throw forbidden("Admin access required");
  return a;
}

export function requireClient(ctx: Ctx, permission?: string): Actor & { clientId: string } {
  const a = requireActor(ctx);
  if (a.role !== "CLIENT" || !a.clientId) throw forbidden("Client access required");
  if (permission) {
    if (!a.permissions.includes(permission)) throw forbidden("This feature is not enabled for your account");
    if (OWNER_ONLY.has(permission) && !a.isOwner) throw forbidden("Only the account owner can do this");
  }
  return a as Actor & { clientId: string };
}

export function hasPermission(a: Actor, permission: string): boolean {
  if (a.role === "SUPER_ADMIN") return true;
  if (!a.permissions.includes(permission)) return false;
  if (OWNER_ONLY.has(permission) && !a.isOwner) return false;
  return true;
}

/**
 * Tenant isolation choke point for business-scoped data.
 * Super admins may access any business. Client users only businesses they are members of,
 * and always within their own client. Returns 404 (not 403) to avoid leaking existence.
 */
export async function assertBusinessAccess(ctx: Ctx, businessId: string, permission?: string) {
  const a = requireActor(ctx);
  if (a.role === "CLIENT") {
    requireClient(ctx, permission);
    if (!a.businessIds.includes(businessId)) throw notFound("Business");
  }
  const business = await db.business.findUnique({ where: { id: businessId } });
  if (!business) throw notFound("Business");
  if (a.role === "CLIENT" && business.clientId !== a.clientId) throw notFound("Business");
  return business;
}

/** Scope filter for queries that list business-owned rows. */
export function businessScope(ctx: Ctx): { in: string[] } | undefined {
  const a = requireActor(ctx);
  if (a.role === "SUPER_ADMIN") return undefined;
  return { in: a.businessIds };
}

export function assertActiveClientAccount(status: string) {
  if (status !== "ACTIVE") throw new AppError("ACCOUNT_DISABLED", "This account is not active. Contact support.");
}
