import { route, searchParams } from "@/server/api";
import { listAllTickets } from "@/server/services/support";

export const GET = route(async (req, ctx) => listAllTickets(ctx, searchParams(req)));
