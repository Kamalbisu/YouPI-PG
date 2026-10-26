import { route } from "@/server/api";
import { requireClient } from "@/server/auth/guards";
import { getQr } from "@/server/services/qr";

export const GET = route<{ id: string }>(async (_req, ctx, { id }) => {
  requireClient(ctx);
  return getQr(ctx, { id });
});
