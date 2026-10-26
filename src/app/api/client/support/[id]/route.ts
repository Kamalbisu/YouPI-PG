import { route } from "@/server/api";
import { closeMyTicket, getTicket } from "@/server/services/support";

type P = { id: string };
export const GET = route<P>(async (_req, ctx, { id }) => getTicket(ctx, id));
export const DELETE = route<P>(async (_req, ctx, { id }) => closeMyTicket(ctx, id));
