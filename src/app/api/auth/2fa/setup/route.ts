import { route } from "@/server/api";
import { beginTotpSetup } from "@/server/services/auth";

export const POST = route(async (_req, ctx) => beginTotpSetup(ctx));
