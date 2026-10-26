import { route, jsonBody, searchParams } from "@/server/api";
import { createTicket, listMyTickets } from "@/server/services/support";

export const GET = route(async (req, ctx) => listMyTickets(ctx, searchParams(req)));
export const POST = route(async (req, ctx) => createTicket(ctx, await jsonBody(req)));
