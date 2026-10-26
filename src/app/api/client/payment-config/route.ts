import { route, searchParams } from "@/server/api";
import { requireClient } from "@/server/auth/guards";
import { listPaymentConfigs } from "@/server/services/payment-config";

/** Status only: active flag, mode, masked key id, enabled methods. Never webhook URLs or secrets. */
export const GET = route(async (req, ctx) => {
  requireClient(ctx, "payments.view");
  return listPaymentConfigs(ctx, searchParams(req));
});
