import { z } from "zod";
import { jsonBody, route } from "@/server/api";
import { parse } from "@/lib/validation";
import { requireUser } from "@/server/auth/guards";
import { markRead } from "@/server/services/notifications";

const Input = z.object({ ids: z.array(z.string().max(64)).max(100).optional(), all: z.boolean().optional() });

export const POST = route(async (req, ctx) => markRead(requireUser(ctx), parse(Input, await jsonBody(req))));
