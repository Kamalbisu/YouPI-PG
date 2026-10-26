import { route, jsonBody } from "@/server/api";
import { suspendClient } from "@/server/services/clients";

export const POST = route<{ id: string }>(async (req, ctx, { id }) => suspendClient(ctx, id, await jsonBody(req)));
