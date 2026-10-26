import { route, jsonBody } from "@/server/api";
import { getBusiness, updateBusiness } from "@/server/services/businesses";

type P = { id: string };
export const GET = route<P>(async (_req, ctx, { id }) => getBusiness(ctx, id));
export const PATCH = route<P>(async (req, ctx, { id }) => updateBusiness(ctx, id, await jsonBody(req)));
