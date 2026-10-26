import { route, jsonBody } from "@/server/api";
import { requireAdmin } from "@/server/auth/guards";
import { updateCategory, deleteCategory } from "@/server/services/categories";

type P = { id: string };

export const PATCH = route<P>(async (req, ctx, { id }) => {
  requireAdmin(ctx);
  return updateCategory(ctx, { ...((await jsonBody(req)) as object), id });
});

export const DELETE = route<P>(async (_req, ctx, { id }) => {
  requireAdmin(ctx);
  return deleteCategory(ctx, { id });
});
