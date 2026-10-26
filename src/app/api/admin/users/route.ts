import { route, searchParams } from "@/server/api";
import { listUsers } from "@/server/services/users";

export const GET = route(async (req, ctx) => listUsers(ctx, searchParams(req)));
