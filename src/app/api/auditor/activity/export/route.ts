import { route, searchParams } from "@/server/api";
import { exportActivityCsv } from "@/server/services/activity";

export const GET = route(async (req, ctx) => {
  const csv = await exportActivityCsv(ctx, searchParams(req));
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="activity-${new Date().toISOString().slice(0, 10)}.csv"`,
      "cache-control": "no-store",
    },
  });
});
