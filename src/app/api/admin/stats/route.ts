import { route } from "@/server/api";
import { dashboardStats } from "@/server/services/users";

export const GET = route(async (_req, ctx) => dashboardStats(ctx));
