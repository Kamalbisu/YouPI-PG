import { route, jsonBody } from "@/server/api";
import { requireAdmin } from "@/server/auth/guards";
import { regenerateQr } from "@/server/services/qr";

export const POST = route<{ id: string }>(async (req, ctx, { id }) => {
  requireAdmin(ctx);
  return regenerateQr(ctx, { ...((await jsonBody(req)) as object), id });
});
