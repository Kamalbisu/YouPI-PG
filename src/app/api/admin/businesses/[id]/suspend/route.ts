import { route, jsonBody } from "@/server/api";
import { suspendBusiness } from "@/server/services/businesses";

export const POST = route<{ id: string }>(async (req, ctx, { id }) => suspendBusiness(ctx, id, await jsonBody(req)));
