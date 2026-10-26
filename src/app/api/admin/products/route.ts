import { route, jsonBody, searchParams } from "@/server/api";
import { requireAdmin } from "@/server/auth/guards";
import { listProducts, createProduct } from "@/server/services/products";

export const GET = route(async (req, ctx) => {
  requireAdmin(ctx);
  return listProducts(ctx, searchParams(req));
});

export const POST = route(async (req, ctx) => {
  requireAdmin(ctx);
  return createProduct(ctx, await jsonBody(req));
});
