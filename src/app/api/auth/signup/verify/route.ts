import { jsonBody, route } from "@/server/api";
import { setSessionCookie } from "@/server/auth/session";
import { signupVerify } from "@/server/services/auth";

export const POST = route(
  async (req, ctx) => {
    const r = await signupVerify(ctx, await jsonBody(req));
    await setSessionCookie(r.token);
    return { role: r.role };
  },
  { public: true },
);
