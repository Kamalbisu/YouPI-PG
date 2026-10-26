import { route, jsonBody } from "@/server/api";
import { listSettings, updateSettings } from "@/server/services/settings";

export const GET = route(async (_req, ctx) => listSettings(ctx));
export const PUT = route(async (req, ctx) => updateSettings(ctx, await jsonBody(req)));
