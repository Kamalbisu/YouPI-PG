import { route, jsonBody } from "@/server/api";
import { requestPasswordReset } from "@/server/services/auth";

export const POST = route(async (req, ctx) => requestPasswordReset(ctx, await jsonBody(req)), { public: true });
