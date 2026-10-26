import { route } from "@/server/api";
import { logout } from "@/server/services/auth";
import { clearSessionCookie } from "@/server/auth/session";

export const POST = route(async (_req, ctx) => {
  await logout(ctx);
  await clearSessionCookie();
});
