import { jsonBody, route } from "@/server/api";
import { reconcilePending } from "@/server/services/payments";

export const POST = route(async (req, ctx) => reconcilePending(ctx, await jsonBody(req)));
