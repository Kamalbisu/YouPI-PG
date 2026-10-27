import { forbidden, unauthenticated } from "@/lib/errors";
import type { Actor, Ctx } from "./types";

export function requireActor(ctx: Ctx): Actor {
  if (!ctx.actor) throw unauthenticated();
  return ctx.actor;
}

/** Admin-only APIs. A signed-in user gets 403, never any admin data. */
export function requireAdmin(ctx: Ctx): Actor {
  const a = requireActor(ctx);
  if (a.role !== "ADMIN") throw forbidden("Admin access required");
  return a;
}

/** User-only APIs. Admins use the admin panel and cannot call these. */
export function requireUser(ctx: Ctx): Actor {
  const a = requireActor(ctx);
  if (a.role !== "USER") throw forbidden("This area is for users only");
  return a;
}

/** Admin 2 (read-only auditor) APIs. Only GET routes should use this guard. */
export function requireAuditor(ctx: Ctx): Actor {
  const a = requireActor(ctx);
  if (a.role !== "AUDITOR") throw forbidden("Auditor access required");
  return a;
}
