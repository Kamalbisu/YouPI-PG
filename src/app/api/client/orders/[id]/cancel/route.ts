import { route } from "@/server/api";
import { requireClient } from "@/server/auth/guards";
import { cancelOrder } from "@/server/services/orders";

export const POST = route<{ id: string }>(async (_req, ctx, { id }) => {
  requireClient(ctx, "orders.manage");
  return cancelOrder(ctx, { orderId: id });
});
