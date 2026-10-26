import { route } from "@/server/api";
import { requireAdmin } from "@/server/auth/guards";
import { verifyPaymentConfig } from "@/server/services/payment-config";

export const POST = route<{ id: string }>(async (_req, ctx, { id }) => {
  requireAdmin(ctx);
  return verifyPaymentConfig(ctx, { id });
});
