import { jsonBody, route } from "@/server/api";
import { createAuditor, listAuditors } from "@/server/services/auditors";

export const GET = route(async (_req, ctx) => listAuditors(ctx));
export const POST = route(async (req, ctx) => createAuditor(ctx, await jsonBody(req)));
