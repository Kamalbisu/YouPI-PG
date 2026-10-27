import { AppError } from "@/lib/errors";
import { route } from "@/server/api";
import { gatewayBody } from "@/server/http-body";
import { handleRefundWebhook } from "@/server/services/refunds";

/** Easebuzz refund events. Needs the shared token (x-webhook-token header or ?token=) and a valid payload hash when one is sent. */
export const POST = route(
  async (req, ctx) => {
    const token = req.headers.get("x-webhook-token") ?? req.nextUrl.searchParams.get("token");
    const result = await handleRefundWebhook(ctx, { token, body: await gatewayBody(req) });
    if (result === "unauthorized") throw new AppError("UNAUTHENTICATED", "Not authorised");
    return { ok: true };
  },
  { public: true, csrf: false },
);
