import { jsonBody, route } from "@/server/api";
import { setSessionCookie } from "@/server/auth/session";
import { userLogin } from "@/server/services/auth";

export const POST = route(
  async (req, ctx) => {
    const r = await userLogin(ctx, await jsonBody(req));
    await setSessionCookie(r.token);
    return { role: r.role };
  },
  { public: true },
);
