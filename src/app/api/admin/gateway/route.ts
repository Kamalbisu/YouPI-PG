import { route } from "@/server/api";
import { requireAdmin } from "@/server/auth/guards";
import { gatewayStatus } from "@/server/services/payments";

/** Whether online payments are set up. Never includes the key or salt. */
export const GET = route(async (_req, ctx) => {
  requireAdmin(ctx);
  return gatewayStatus();
});
