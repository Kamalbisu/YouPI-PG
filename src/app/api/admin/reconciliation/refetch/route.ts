import { route, jsonBody } from "@/server/api";
import { requireAdmin } from "@/server/auth/guards";
import { refetchOrderPayment } from "@/server/services/reconciliation";

export const POST = route(async (req, ctx) => {
  requireAdmin(ctx);
  return refetchOrderPayment(ctx, await jsonBody(req));
});
