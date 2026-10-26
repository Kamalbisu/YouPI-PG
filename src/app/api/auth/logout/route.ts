import { route } from "@/server/api";
import { clearSessionCookie, revokeSession } from "@/server/auth/session";

export const POST = route(async (_req, ctx) => {
  if (ctx.actor?.sessionId) await revokeSession(ctx.actor.sessionId);
  await clearSessionCookie();
  return { ok: true };
});
