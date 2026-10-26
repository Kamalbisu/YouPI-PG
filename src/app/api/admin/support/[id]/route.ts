import { route, jsonBody } from "@/server/api";
import { requireAdmin } from "@/server/auth/guards";
import { getTicket, setTicketPriority, setTicketStatus } from "@/server/services/support";

type P = { id: string };
export const GET = route<P>(async (_req, ctx, { id }) => {
  requireAdmin(ctx);
  return getTicket(ctx, id);
});
/** Body: { status } and/or { priority }. */
export const PATCH = route<P>(async (req, ctx, { id }) => {
  requireAdmin(ctx);
  const body = (await jsonBody(req)) as { status?: unknown; priority?: unknown };
  if (body.status !== undefined) await setTicketStatus(ctx, id, { status: body.status });
  if (body.priority !== undefined) await setTicketPriority(ctx, id, { priority: body.priority });
  return getTicket(ctx, id);
});
