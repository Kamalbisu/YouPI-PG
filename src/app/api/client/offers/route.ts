import { route, jsonBody, searchParams } from "@/server/api";
import { requireClient } from "@/server/auth/guards";
import { listOffers, createOffer } from "@/server/services/offers";

export const GET = route(async (req, ctx) => {
  requireClient(ctx);
  return listOffers(ctx, searchParams(req));
});

export const POST = route(async (req, ctx) => {
  requireClient(ctx);
  return createOffer(ctx, await jsonBody(req));
});
