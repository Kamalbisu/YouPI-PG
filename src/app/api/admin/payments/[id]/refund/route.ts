import { jsonBody, route } from "@/server/api";
import { createRefund } from "@/server/services/refunds";

export const POST = route<{ id: string }>(async (req, ctx, { id }) => createRefund(ctx, id, await jsonBody(req)));
