import { jsonBody, route } from "@/server/api";
import { setSessionCookie } from "@/server/auth/session";
import { auditorLogin } from "@/server/services/auth";

export const POST = route(
  async (req, ctx) => {
    const r = await auditorLogin(ctx, await jsonBody(req));
    await setSessionCookie(r.token);
    return { role: r.role };
  },
  { public: true },
);
