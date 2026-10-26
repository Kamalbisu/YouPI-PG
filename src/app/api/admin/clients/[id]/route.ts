import { route, jsonBody } from "@/server/api";
import { getClient, updateClient } from "@/server/services/clients";

type P = { id: string };
export const GET = route<P>(async (_req, ctx, { id }) => getClient(ctx, id));
export const PATCH = route<P>(async (req, ctx, { id }) => updateClient(ctx, id, await jsonBody(req)));
