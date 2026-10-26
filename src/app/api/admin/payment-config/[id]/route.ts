import { route } from "@/server/api";
import { requireAdmin } from "@/server/auth/guards";
import { deletePaymentConfig } from "@/server/services/payment-config";

export const DELETE = route<{ id: string }>(async (_req, ctx, { id }) => {
  requireAdmin(ctx);
  return deletePaymentConfig(ctx, { id });
});
