import { route, searchParams } from "@/server/api";
import { listAuditLogs } from "@/server/services/audit-logs";

export const GET = route(async (req, ctx) => listAuditLogs(ctx, searchParams(req)));
