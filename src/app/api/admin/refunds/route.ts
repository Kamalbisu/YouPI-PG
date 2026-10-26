import { route, jsonBody, searchParams } from "@/server/api";
import { requireAdmin } from "@/server/auth/guards";
import { listRefunds, requestRefund } from "@/server/services/refunds";

export const GET = route(async (req, ctx) => {
  requireAdmin(ctx);
  return listRefunds(ctx, searchParams(req));
});

export const POST = route(async (req, ctx) => {
  requireAdmin(ctx);
  return requestRefund(ctx, await jsonBody(req));
});
