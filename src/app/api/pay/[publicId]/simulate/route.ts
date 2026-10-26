import { route, jsonBody } from "@/server/api";
import { simulatorComplete } from "@/server/services/checkout";
import { parse } from "@/lib/validation";
import { z } from "zod";

const body = z.object({ attemptId: z.string().trim().min(1).max(64), outcome: z.enum(["success", "failure", "cancel"]) });

/** Development only: refuses (403) unless the simulator is enabled and the app is not in production. */
export const POST = route<{ publicId: string }>(
  async (req, ctx, { publicId }) => {
    const d = parse(body, await jsonBody(req));
    return simulatorComplete(publicId, d.attemptId, d.outcome, ctx);
  },
  { public: true },
);
