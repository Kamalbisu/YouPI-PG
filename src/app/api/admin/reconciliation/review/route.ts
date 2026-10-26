import { route, jsonBody } from "@/server/api";
import { requireAdmin } from "@/server/auth/guards";
import { markReconciliationReviewed } from "@/server/services/reconciliation";

export const POST = route(async (req, ctx) => {
  requireAdmin(ctx);
  return markReconciliationReviewed(ctx, await jsonBody(req));
});
