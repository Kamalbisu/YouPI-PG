import { route, searchParams } from "@/server/api";
import { auditCsvStream } from "@/server/services/audit-logs";
import { dateStamp } from "@/lib/ids";

export const GET = route(async (req, ctx) => {
  const stream = auditCsvStream(ctx, searchParams(req)); // admin check happens before any byte is produced
  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="audit-log-${dateStamp()}.csv"`,
      "Cache-Control": "no-store",
    },
  });
});
