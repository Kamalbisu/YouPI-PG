import { route, searchParams } from "@/server/api";
import { listBusinesses } from "@/server/services/businesses";

export const GET = route(async (req, ctx) => listBusinesses(ctx, searchParams(req)));
