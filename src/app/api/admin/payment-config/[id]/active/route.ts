import { route, jsonBody } from "@/server/api";
import { requireAdmin } from "@/server/auth/guards";
import { setPaymentConfigActive } from "@/server/services/payment-config";

export const POST = route<{ id: string }>(async (req, ctx, { id }) => {
  requireAdmin(ctx);
  const body = (await jsonBody(req)) as Record<string, unknown>;
  return setPaymentConfigActive(ctx, { ...body, id });
});
