import { route, jsonBody } from "@/server/api";
import { addTeamMember, listTeam } from "@/server/services/team";

type P = { id: string };
export const GET = route<P>(async (_req, ctx, { id }) => listTeam(ctx, id));
export const POST = route<P>(async (req, ctx, { id }) => addTeamMember(ctx, id, await jsonBody(req)));
