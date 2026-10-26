import { route } from "@/server/api";
import { requireAdmin } from "@/server/auth/guards";
import { getTransaction } from "@/server/services/transactions";

export const GET = route<{ id: string }>(async (_req, ctx, { id }) => {
  requireAdmin(ctx);
  return getTransaction(ctx, id);
});
