import { route, jsonBody } from "@/server/api";
import { getProfile, updateProfile } from "@/server/services/profile";

export const GET = route(async (_req, ctx) => getProfile(ctx));
export const PATCH = route(async (req, ctx) => updateProfile(ctx, await jsonBody(req)));
