import { route } from "@/server/api";
import { requireAdmin } from "@/server/auth/guards";
import { getOrder } from "@/server/services/orders";

export const GET = route<{ id: string }>(async (_req, ctx, { id }) => {
  requireAdmin(ctx);
  return getOrder(ctx, id);
});
