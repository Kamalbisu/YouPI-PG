import { route, jsonBody } from "@/server/api";
import { requireClient } from "@/server/auth/guards";
import { revokeQr } from "@/server/services/qr";

export const POST = route<{ id: string }>(async (req, ctx, { id }) => {
  requireClient(ctx);
  return revokeQr(ctx, { ...((await jsonBody(req)) as object), id });
});
