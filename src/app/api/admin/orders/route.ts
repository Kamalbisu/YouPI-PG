import { route, searchParams } from "@/server/api";
import { requireAdmin } from "@/server/auth/guards";
import { listOrders } from "@/server/services/orders";

export const GET = route(async (req, ctx) => {
  requireAdmin(ctx);
  return listOrders(ctx, searchParams(req));
});
