import { route, searchParams } from "@/server/api";
import { listTransactionsAdmin } from "@/server/services/transactions";

export const GET = route(async (req, ctx) => listTransactionsAdmin(ctx, searchParams(req)));
