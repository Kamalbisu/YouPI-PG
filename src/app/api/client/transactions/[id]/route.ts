import { route } from "@/server/api";
import { requireClient } from "@/server/auth/guards";
import { getTransaction } from "@/server/services/transactions";

export const GET = route<{ id: string }>(async (_req, ctx, { id }) => {
  requireClient(ctx, "payments.view");
  return getTransaction(ctx, id);
});
