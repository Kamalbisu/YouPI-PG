import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { route } from "@/server/api";
import { gatewayBody } from "@/server/http-body";
import { handlePaymentCallback } from "@/server/services/payments";

const to = (path: string) => NextResponse.redirect(new URL(path, env().APP_URL), 303);

/**
 * Where Easebuzz sends the browser after payment (surl and furl). Public on purpose: there is no session
 * and no origin check, because trust comes from the signed response (see handlePaymentCallback).
 */
export const POST = route(
  async (req, ctx) => {
    const { paymentId } = await handlePaymentCallback(ctx, await gatewayBody(req));
    return to(paymentId ? `/dashboard/payments/${paymentId}` : "/dashboard/payments");
  },
  { public: true, csrf: false },
);

/** A plain visit (for example a refresh after the redirect) never changes anything. */
export const GET = route(async () => to("/dashboard/payments"), { public: true });
