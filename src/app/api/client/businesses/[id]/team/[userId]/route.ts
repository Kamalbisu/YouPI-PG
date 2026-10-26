import { route } from "@/server/api";
import { removeTeamMember, resendTeamInvite } from "@/server/services/team";

type P = { id: string; userId: string };
export const DELETE = route<P>(async (_req, ctx, { id, userId }) => removeTeamMember(ctx, id, userId));
/** POST re-sends the invite to a manager who has not set a password yet. */
export const POST = route<P>(async (_req, ctx, { id, userId }) => resendTeamInvite(ctx, id, userId));
