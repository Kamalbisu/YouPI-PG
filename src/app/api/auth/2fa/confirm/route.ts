import { route, jsonBody } from "@/server/api";
import { confirmTotpSetup } from "@/server/services/auth";

export const POST = route(async (req, ctx) => {
  await confirmTotpSetup(ctx, await jsonBody(req));
});
