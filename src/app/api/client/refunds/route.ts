import { route, jsonBody, searchParams } from "@/server/api";
import { requireClient } from "@/server/auth/guards";
import { listRefunds, requestRefund } from "@/server/services/refunds";

export const GET = route(async (req, ctx) => {
  requireClient(ctx, "payments.view");
  return listRefunds(ctx, searchParams(req));
});

export const POST = route(async (req, ctx) => {
  requireClient(ctx, "payments.refund");
  return requestRefund(ctx, await jsonBody(req));
});
