import { route, jsonBody } from "@/server/api";
import { login } from "@/server/services/auth";
import { setSessionCookie } from "@/server/auth/session";

export const POST = route(
  async (req, ctx) => {
    const r = await login(ctx, await jsonBody(req));
    await setSessionCookie(r.token);
    return { role: r.role, redirectTo: r.redirectTo };
  },
  { public: true },
);
