import { route, jsonBody } from "@/server/api";
import { createBusiness, listMyBusinesses } from "@/server/services/businesses";

export const GET = route(async (_req, ctx) => listMyBusinesses(ctx));
export const POST = route(async (req, ctx) => createBusiness(ctx, await jsonBody(req)));
