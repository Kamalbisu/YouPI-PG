import { route, jsonBody, searchParams } from "@/server/api";
import { requireAdmin } from "@/server/auth/guards";
import { listPaymentConfigs, savePaymentConfig, listPaymentOverview } from "@/server/services/payment-config";

/** GET ?businessId=... returns that business's providers; without businessId returns the paged overview. */
export const GET = route(async (req, ctx) => {
  requireAdmin(ctx);
  const q = searchParams(req);
  return q.businessId ? listPaymentConfigs(ctx, q) : listPaymentOverview(ctx, q);
});

export const POST = route(async (req, ctx) => {
  requireAdmin(ctx);
  return savePaymentConfig(ctx, await jsonBody(req));
});
