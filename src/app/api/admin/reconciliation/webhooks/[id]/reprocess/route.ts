import { route } from "@/server/api";
import { requireAdmin } from "@/server/auth/guards";
import { reprocessWebhook } from "@/server/services/webhooks";

export const POST = route<{ id: string }>(async (_req, ctx, { id }) => {
  requireAdmin(ctx);
  return reprocessWebhook(ctx, { id });
});
