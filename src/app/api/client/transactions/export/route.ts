import { route, searchParams } from "@/server/api";
import { requireClient } from "@/server/auth/guards";
import { exportTransactionsCsv } from "@/server/services/transactions";

export const GET = route(async (req, ctx) => {
  requireClient(ctx, "reports.export");
  const { filename, csv, truncated } = await exportTransactionsCsv(ctx, searchParams(req));
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Export-Truncated": truncated ? "1" : "0",
    },
  });
});
