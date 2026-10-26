import { route } from "@/server/api";
import { requireAdmin } from "@/server/auth/guards";
import { archiveProduct } from "@/server/services/products";

export const POST = route<{ id: string }>(async (_req, ctx, { id }) => {
  requireAdmin(ctx);
  return archiveProduct(ctx, { id });
});
