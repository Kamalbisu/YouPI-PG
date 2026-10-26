import { route, jsonBody } from "@/server/api";
import { getUpiPayment } from "@/server/services/checkout";

/** UPI link + QR for an open attempt (Cashfree). Body: { attemptId }. */
export const POST = route<{ publicId: string }>(
  async (req, ctx, { publicId }) => {
    const body = (await jsonBody(req)) as Record<string, unknown>;
    return getUpiPayment(ctx, { ...body, publicId });
  },
  { public: true },
);
