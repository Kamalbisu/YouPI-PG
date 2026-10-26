import { route, jsonBody } from "@/server/api";
import { changePassword } from "@/server/services/auth";

export const POST = route(async (req, ctx) => {
  await changePassword(ctx, await jsonBody(req));
});
