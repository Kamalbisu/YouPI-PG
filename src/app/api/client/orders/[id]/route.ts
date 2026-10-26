import { route } from "@/server/api";
import { requireClient } from "@/server/auth/guards";
import { getOrder } from "@/server/services/orders";

export const GET = route<{ id: string }>(async (_req, ctx, { id }) => {
  requireClient(ctx, "payments.view");
  return getOrder(ctx, id);
});
