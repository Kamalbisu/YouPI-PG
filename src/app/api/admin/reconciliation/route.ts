import { route, searchParams } from "@/server/api";
import { requireAdmin } from "@/server/auth/guards";
import { listReconciliation } from "@/server/services/reconciliation";

export const GET = route(async (req, ctx) => {
  requireAdmin(ctx);
  return listReconciliation(ctx, searchParams(req));
});
