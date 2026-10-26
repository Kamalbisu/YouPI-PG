import { route, searchParams } from "@/server/api";
import { requireClient } from "@/server/auth/guards";
import { listOrders } from "@/server/services/orders";

export const GET = route(async (req, ctx) => {
  requireClient(ctx, "payments.view");
  return listOrders(ctx, searchParams(req));
});
