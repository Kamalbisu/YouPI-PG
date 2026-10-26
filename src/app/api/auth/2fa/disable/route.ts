import { route, jsonBody } from "@/server/api";
import { disableTotp } from "@/server/services/auth";

export const POST = route(async (req, ctx) => {
  await disableTotp(ctx, await jsonBody(req));
});
