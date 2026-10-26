import { route } from "@/server/api";
import { requireAdmin } from "@/server/auth/guards";
import { getBusiness } from "@/server/services/businesses";

export const GET = route<{ id: string }>(async (_req, ctx, { id }) => {
  requireAdmin(ctx);
  return getBusiness(ctx, id);
});
