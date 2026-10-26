import { route, jsonBody } from "@/server/api";
import { resetClientPassword } from "@/server/services/clients";

export const POST = route<{ id: string }>(async (req, ctx, { id }) => resetClientPassword(ctx, id, await jsonBody(req)));
