import { jsonBody, route } from "@/server/api";
import { otpLoginStart } from "@/server/services/auth";

export const POST = route(async (req, ctx) => otpLoginStart(ctx, await jsonBody(req)), { public: true });
