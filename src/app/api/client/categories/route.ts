import { route, jsonBody, searchParams } from "@/server/api";
import { requireClient } from "@/server/auth/guards";
import { listCategories, createCategory } from "@/server/services/categories";

export const GET = route(async (req, ctx) => {
  requireClient(ctx);
  return listCategories(ctx, searchParams(req));
});

export const POST = route(async (req, ctx) => {
  requireClient(ctx);
  return createCategory(ctx, await jsonBody(req));
});
