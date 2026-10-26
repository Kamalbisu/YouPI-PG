import { route, jsonBody } from "@/server/api";
import { rejectBusiness } from "@/server/services/businesses";

export const POST = route<{ id: string }>(async (req, ctx, { id }) => rejectBusiness(ctx, id, await jsonBody(req)));
