import { route, searchParams } from "@/server/api";
import { listPaymentsAdmin } from "@/server/services/payments";

export const GET = route(async (req, ctx) => listPaymentsAdmin(ctx, searchParams(req)));
