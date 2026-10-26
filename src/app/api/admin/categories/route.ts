import { route, jsonBody, searchParams } from "@/server/api";
import { requireAdmin } from "@/server/auth/guards";
import { listCategories, createCategory } from "@/server/services/categories";

export const GET = route(async (req, ctx) => {
  requireAdmin(ctx);
  return listCategories(ctx, searchParams(req));
});

export const POST = route(async (req, ctx) => {
  requireAdmin(ctx);
  return createCategory(ctx, await jsonBody(req));
});
