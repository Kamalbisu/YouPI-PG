import { route, jsonBody } from "@/server/api";
import { verifyCheckoutReturn } from "@/server/services/payment-verification";

/** Razorpay checkout return proof. The signature is verified server side; the browser alone never marks an order paid. */
export const POST = route<{ publicId: string }>(
  async (req, ctx, { publicId }) => {
    const body = (await jsonBody(req)) as Record<string, unknown>;
    return verifyCheckoutReturn(ctx, { ...body, publicId });
  },
  { public: true },
);
