import { route, jsonBody } from "@/server/api";
import { requireClient } from "@/server/auth/guards";
import { regenerateQr } from "@/server/services/qr";

export const POST = route<{ id: string }>(async (req, ctx, { id }) => {
  requireClient(ctx);
  return regenerateQr(ctx, { ...((await jsonBody(req)) as object), id });
});
