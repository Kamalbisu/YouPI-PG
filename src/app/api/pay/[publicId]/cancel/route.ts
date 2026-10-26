import { route, jsonBody } from "@/server/api";
import { cancelAttempt } from "@/server/services/checkout";

export const POST = route<{ publicId: string }>(
  async (req, ctx, { publicId }) => {
    const body = (await jsonBody(req)) as Record<string, unknown>;
    return cancelAttempt(ctx, { ...body, publicId });
  },
  { public: true },
);
