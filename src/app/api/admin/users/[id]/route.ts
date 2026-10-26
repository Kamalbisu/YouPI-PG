import { jsonBody, route } from "@/server/api";
import { getUserDetail, setUserStatus } from "@/server/services/users";

type P = { id: string };
export const GET = route<P>(async (_req, ctx, { id }) => getUserDetail(ctx, id));
export const PATCH = route<P>(async (req, ctx, { id }) => setUserStatus(ctx, id, await jsonBody(req)));
