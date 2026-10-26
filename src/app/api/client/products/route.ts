import { route, jsonBody, searchParams } from "@/server/api";
import { requireClient } from "@/server/auth/guards";
import { listProducts, createProduct } from "@/server/services/products";

export const GET = route(async (req, ctx) => {
  requireClient(ctx);
  return listProducts(ctx, searchParams(req));
});

export const POST = route(async (req, ctx) => {
  requireClient(ctx);
  return createProduct(ctx, await jsonBody(req));
});
