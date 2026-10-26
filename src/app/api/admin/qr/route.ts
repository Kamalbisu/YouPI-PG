import { route, jsonBody, searchParams } from "@/server/api";
import { requireAdmin } from "@/server/auth/guards";
import { listQr, createQr } from "@/server/services/qr";

export const GET = route(async (req, ctx) => {
  requireAdmin(ctx);
  return listQr(ctx, searchParams(req));
});

export const POST = route(async (req, ctx) => {
  requireAdmin(ctx);
  return createQr(ctx, await jsonBody(req));
});
