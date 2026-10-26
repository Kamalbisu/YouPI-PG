import { route } from "@/server/api";
import { enforceRateLimit } from "@/lib/rate-limit";
import { refreshPaymentStatus } from "@/server/services/payment-verification";

/** Polling endpoint for the result page: asks the provider (server side) and returns the verified state. */
export const GET = route<{ publicId: string }>(
  async (_req, ctx, { publicId }) => {
    await enforceRateLimit(`pay:status:ip:${ctx.ip ?? "unknown"}`, 120, 60, "Too many status checks. Please wait a moment.");
    return refreshPaymentStatus(publicId, ctx);
  },
  { public: true },
);
