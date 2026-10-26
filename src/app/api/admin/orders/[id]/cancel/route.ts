import { route } from "@/server/api";
import { requireAdmin } from "@/server/auth/guards";
import { cancelOrder } from "@/server/services/orders";

export const POST = route<{ id: string }>(async (_req, ctx, { id }) => {
  requireAdmin(ctx);
  return cancelOrder(ctx, { orderId: id });
});
