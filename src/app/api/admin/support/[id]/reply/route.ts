import { route, jsonBody } from "@/server/api";
import { requireAdmin } from "@/server/auth/guards";
import { replyToTicket } from "@/server/services/support";

export const POST = route<{ id: string }>(async (req, ctx, { id }) => {
  requireAdmin(ctx);
  return replyToTicket(ctx, id, await jsonBody(req));
});
