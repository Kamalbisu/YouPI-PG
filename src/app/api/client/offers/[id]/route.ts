import { route, jsonBody } from "@/server/api";
import { requireClient } from "@/server/auth/guards";
import { updateOffer, deleteOffer } from "@/server/services/offers";

type P = { id: string };

export const PATCH = route<P>(async (req, ctx, { id }) => {
  requireClient(ctx);
  return updateOffer(ctx, { ...((await jsonBody(req)) as object), id });
});

export const DELETE = route<P>(async (_req, ctx, { id }) => {
  requireClient(ctx);
  return deleteOffer(ctx, { id });
});
