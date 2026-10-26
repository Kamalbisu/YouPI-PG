import { route, jsonBody } from "@/server/api";
import { requireAdmin } from "@/server/auth/guards";
import { getProduct, updateProduct, deleteProduct } from "@/server/services/products";

type P = { id: string };

export const GET = route<P>(async (_req, ctx, { id }) => {
  requireAdmin(ctx);
  return getProduct(ctx, { id });
});

export const PATCH = route<P>(async (req, ctx, { id }) => {
  requireAdmin(ctx);
  const body = await jsonBody(req);
  return updateProduct(ctx, { ...(body as object), id });
});

export const DELETE = route<P>(async (_req, ctx, { id }) => {
  requireAdmin(ctx);
  return deleteProduct(ctx, { id });
});
