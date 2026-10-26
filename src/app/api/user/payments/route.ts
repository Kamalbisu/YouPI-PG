import { jsonBody, route, searchParams } from "@/server/api";
import { listPaymentsForUser, startPayment } from "@/server/services/payments";

export const GET = route(async (req, ctx) => listPaymentsForUser(ctx, searchParams(req)));
export const POST = route(async (req, ctx) => startPayment(ctx, await jsonBody(req)));
