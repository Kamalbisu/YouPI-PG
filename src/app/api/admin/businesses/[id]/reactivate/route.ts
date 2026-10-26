import { route, jsonBody } from "@/server/api";
import { reactivateBusiness } from "@/server/services/businesses";

export const POST = route<{ id: string }>(async (req, ctx, { id }) => reactivateBusiness(ctx, id, await jsonBody(req)));
