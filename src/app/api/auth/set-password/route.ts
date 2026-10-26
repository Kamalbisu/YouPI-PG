import { route, jsonBody } from "@/server/api";
import { setPasswordWithToken } from "@/server/services/auth";

export const POST = route(async (req, ctx) => setPasswordWithToken(ctx, await jsonBody(req)), { public: true });
