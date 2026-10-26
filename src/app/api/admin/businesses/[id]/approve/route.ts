import { route, jsonBody } from "@/server/api";
import { approveBusiness } from "@/server/services/businesses";

export const POST = route<{ id: string }>(async (req, ctx, { id }) => approveBusiness(ctx, id, await jsonBody(req)));
