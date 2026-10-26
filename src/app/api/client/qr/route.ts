import { route, jsonBody, searchParams } from "@/server/api";
import { requireClient } from "@/server/auth/guards";
import { listQr, createQr } from "@/server/services/qr";

export const GET = route(async (req, ctx) => {
  requireClient(ctx);
  return listQr(ctx, searchParams(req));
});

export const POST = route(async (req, ctx) => {
  requireClient(ctx);
  return createQr(ctx, await jsonBody(req));
});
