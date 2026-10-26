import { route, jsonBody } from "@/server/api";
import { requireClient } from "@/server/auth/guards";
import { setProductAvailability } from "@/server/services/products";

export const POST = route<{ id: string }>(async (req, ctx, { id }) => {
  requireClient(ctx);
  const body = await jsonBody(req);
  return setProductAvailability(ctx, { ...(body as object), id });
});
