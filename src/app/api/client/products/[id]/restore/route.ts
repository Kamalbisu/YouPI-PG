import { route } from "@/server/api";
import { requireClient } from "@/server/auth/guards";
import { restoreProduct } from "@/server/services/products";

export const POST = route<{ id: string }>(async (_req, ctx, { id }) => {
  requireClient(ctx);
  return restoreProduct(ctx, { id });
});
