import { redirect } from "next/navigation";
import { getCtx } from "./session";
import type { Actor, Ctx } from "./types";

/** For server components / layouts of /admin pages. */
export async function requireAdminPage(): Promise<{ ctx: Ctx; actor: Actor }> {
  const ctx = await getCtx();
  if (!ctx.actor) redirect("/admin/login");
  if (ctx.actor.role !== "SUPER_ADMIN") redirect("/admin/login?error=forbidden");
  return { ctx, actor: ctx.actor };
}

/** For server components / layouts of /client pages. */
export async function requireClientPage(): Promise<{ ctx: Ctx; actor: Actor & { clientId: string } }> {
  const ctx = await getCtx();
  if (!ctx.actor) redirect("/client/login");
  if (ctx.actor.role !== "CLIENT" || !ctx.actor.clientId) redirect("/client/login?error=forbidden");
  return { ctx, actor: ctx.actor as Actor & { clientId: string } };
}
