import { route, searchParams } from "@/server/api";
import { clientLoginActivity } from "@/server/services/clients";

export const GET = route<{ id: string }>(async (req, ctx, { id }) => clientLoginActivity(ctx, id, searchParams(req)));
