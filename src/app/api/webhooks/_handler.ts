import type { NextRequest } from "next/server";
import { AppError } from "@/lib/errors";
import type { Ctx } from "@/server/auth/types";
import type { ProviderId } from "@/server/payments";
import { ingestWebhook, WEBHOOK_MAX_BYTES } from "@/server/services/webhooks";

/** Shared webhook handler: raw body in, verified-or-rejected out. Providers only look at the status code. */
export async function handleWebhook(req: NextRequest, ctx: Ctx, provider: ProviderId, configId: string | null): Promise<Response> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > WEBHOOK_MAX_BYTES) throw new AppError("BAD_REQUEST", "Payload too large");
  const rawBody = await req.text();
  const res = await ingestWebhook(ctx, { provider, rawBody, headers: req.headers, configId });
  return Response.json({ received: res.httpStatus < 400, result: res.result }, { status: res.httpStatus });
}
