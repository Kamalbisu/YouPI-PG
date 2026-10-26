import { route, searchParams } from "@/server/api";
import { listActivity } from "@/server/services/activity";

export const GET = route(async (req, ctx) => listActivity(ctx, searchParams(req)));
