import { jsonBody, route } from "@/server/api";
import { setSessionCookie } from "@/server/auth/session";
import { otpLoginVerify } from "@/server/services/auth";

export const POST = route(
  async (req, ctx) => {
    const r = await otpLoginVerify(ctx, await jsonBody(req));
    await setSessionCookie(r.token);
    return { role: r.role, created: r.created };
  },
  { public: true },
);
