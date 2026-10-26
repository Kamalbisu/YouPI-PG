import { route, searchParams } from "@/server/api";
import { requireAdmin } from "@/server/auth/guards";
import { listTransactions, transactionTotals } from "@/server/services/transactions";

/** ?totals=1 returns the summary (count, gross, refunded, fee, net) for the same filters instead of a page. */
export const GET = route(async (req, ctx) => {
  requireAdmin(ctx);
  const q = searchParams(req);
  return q.totals === "1" ? transactionTotals(ctx, q) : listTransactions(ctx, q);
});
