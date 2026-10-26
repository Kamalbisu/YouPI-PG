import { route, jsonBody } from "@/server/api";
import { updateClientPermissions } from "@/server/services/clients";

export const PUT = route<{ id: string }>(async (req, ctx, { id }) => updateClientPermissions(ctx, id, await jsonBody(req)));
