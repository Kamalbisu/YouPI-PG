import { route, jsonBody } from "@/server/api";
import { replyToTicket } from "@/server/services/support";

export const POST = route<{ id: string }>(async (req, ctx, { id }) => replyToTicket(ctx, id, await jsonBody(req)));
