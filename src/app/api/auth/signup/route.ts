import { jsonBody, route } from "@/server/api";
import { signupStart } from "@/server/services/auth";

export const POST = route(async (req, ctx) => signupStart(ctx, await jsonBody(req)), { public: true });
