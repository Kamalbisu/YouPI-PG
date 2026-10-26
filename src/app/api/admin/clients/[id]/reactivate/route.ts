import { route, jsonBody } from "@/server/api";
import { reactivateClient } from "@/server/services/clients";

export const POST = route<{ id: string }>(async (req, ctx, { id }) => reactivateClient(ctx, id, await jsonBody(req)));
