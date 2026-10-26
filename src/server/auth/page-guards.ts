import { redirect } from "next/navigation";
import { getCtx } from "./session";
import type { Actor, Ctx } from "./types";

/** For server components / layouts of /admin pages. */
export async function requireAdminPage(): Promise<{ ctx: Ctx; actor: Actor }> {
  const ctx = await getCtx();
  if (!ctx.actor) redirect("/admin/login");
  if (ctx.actor.role !== "ADMIN") redirect("/admin/login?error=forbidden");
  return { ctx, actor: ctx.actor };
}

/** For server components / layouts of the user dashboard. */
export async function requireUserPage(): Promise<{ ctx: Ctx; actor: Actor }> {
  const ctx = await getCtx();
  if (!ctx.actor) redirect("/login");
  if (ctx.actor.role !== "USER") redirect("/login?error=forbidden");
  return { ctx, actor: ctx.actor };
}
