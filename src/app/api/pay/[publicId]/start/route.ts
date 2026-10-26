import { route, jsonBody } from "@/server/api";
import { startPayment } from "@/server/services/checkout";

export const POST = route<{ publicId: string }>(
  async (req, ctx, { publicId }) => {
    const body = (await jsonBody(req)) as Record<string, unknown>;
    return startPayment(ctx, { ...body, publicId });
  },
  { public: true },
);
