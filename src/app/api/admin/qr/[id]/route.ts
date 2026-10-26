import { route } from "@/server/api";
import { requireAdmin } from "@/server/auth/guards";
import { getQr } from "@/server/services/qr";

export const GET = route<{ id: string }>(async (_req, ctx, { id }) => {
  requireAdmin(ctx);
  return getQr(ctx, { id });
});
