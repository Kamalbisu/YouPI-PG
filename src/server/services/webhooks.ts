import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { decryptSecret, sha256Hex } from "@/lib/crypto";
import { AppError, notFound } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { simulatorEnabled } from "@/lib/env";
import { enforceRateLimit } from "@/lib/rate-limit";
import { parse } from "@/lib/validation";
import { requireAdmin } from "@/server/auth/guards";
import type { Ctx } from "@/server/auth/types";
import { platformCredentials } from "@/server/payments/credentials";
import { getProvider, WebhookSignatureError, type NormalizedEvent, type ProviderId } from "@/server/payments";
import { CASHFREE_WEBHOOK_TOLERANCE_SEC } from "@/server/payments/cashfree";
import { applyPaymentEvent, type PaymentOutcome } from "./payment-verification";
import { applyRefundEvent } from "./refunds";

/** Hard cap on a webhook body. Provider payloads are a few KB. */
export const WEBHOOK_MAX_BYTES = 256 * 1024;

export type WebhookResult = "PROCESSED" | "IGNORED" | "DUPLICATE" | "FAILED" | "INVALID_SIGNATURE" | "BAD_REQUEST";

export interface WebhookIngestResult {
  /** HTTP status the route must answer with. 200 means "acknowledged, do not resend". */
  httpStatus: number;
  result: WebhookResult;
  eventId: string | null;
  outcome: PaymentOutcome | null;
}

interface StoredPayload {
  normalized: NormalizedEvent;
  body: unknown;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { unparseable: true };
  }
}

/** Resolves the webhook secret. "platform" uses environment secrets; a configId uses that business's stored secret. */
async function resolveSecret(provider: ProviderId, configId: string | null): Promise<{ secret: string | null; configRef: string }> {
  if (provider === "DEV_SIMULATOR") return { secret: "simulator", configRef: configId ?? "platform" };
  if (configId) {
    const cfg = await db.paymentProviderConfig.findUnique({ where: { id: configId } });
    if (!cfg || cfg.provider !== provider) throw notFound("Webhook endpoint");
    return { secret: cfg.webhookSecretEnc ? decryptSecret(cfg.webhookSecretEnc) : null, configRef: configId };
  }
  return { secret: platformCredentials(provider)?.webhookSecret ?? null, configRef: "platform" };
}

const expectedConfig = (configRef: string | null | undefined, provider: ProviderId): string | null | undefined =>
  provider === "DEV_SIMULATOR" ? undefined : configRef && configRef !== "platform" ? configRef : null;

async function processStored(ctx: Ctx, eventDbId: string): Promise<{ status: "PROCESSED" | "IGNORED" | "FAILED"; outcome: PaymentOutcome | null; error?: string }> {
  const ev = await db.webhookEvent.findUniqueOrThrow({ where: { id: eventDbId } });
  const stored = ev.payload as unknown as StoredPayload;
  const n = stored.normalized;
  let status: "PROCESSED" | "IGNORED" | "FAILED" = "PROCESSED";
  let error: string | undefined;
  let outcome: PaymentOutcome | null = null;
  try {
    const expect = expectedConfig(ev.configRef, ev.provider);
    if (n.kind === "payment") {
      const r = await applyPaymentEvent(ctx, { provider: ev.provider, payment: n.payment, source: "WEBHOOK", expectConfigId: expect });
      outcome = r.outcome;
      if (r.outcome === "UNMATCHED") {
        status = "IGNORED";
        error = "No matching payment attempt for this event";
      }
    } else if (n.kind === "refund") {
      const r = await applyRefundEvent(ctx, { provider: ev.provider, refund: n.refund, expectConfigId: expect });
      if (!r.matched) {
        status = "IGNORED";
        error = r.note ?? "No matching refund or transaction for this event";
      }
    } else {
      status = "IGNORED";
      error = `Event type ${n.eventType} is not handled`;
    }
  } catch (e) {
    status = "FAILED";
    error = (e instanceof AppError ? e.message : e instanceof Error ? e.message : "Processing failed").slice(0, 300);
  }
  await db.webhookEvent.update({ where: { id: ev.id }, data: { status, error: error ?? null, processedAt: new Date() } });
  return { status, outcome, error };
}

/**
 * Verified webhook intake (shared by the HTTP routes and the dev simulator).
 * Order of operations: size limit, rate limit, resolve secret, VERIFY SIGNATURE, store, de-duplicate, process.
 * Nothing in the body is trusted before the signature is verified.
 */
export async function ingestWebhook(
  ctx: Ctx,
  input: { provider: ProviderId; rawBody: string; headers: Headers | Record<string, string | undefined>; configId?: string | null; now?: Date },
): Promise<WebhookIngestResult> {
  const { provider, rawBody, headers } = input;
  if (provider === "DEV_SIMULATOR" && !simulatorEnabled()) throw notFound("Webhook endpoint");
  if (Buffer.byteLength(rawBody, "utf8") > WEBHOOK_MAX_BYTES) throw new AppError("BAD_REQUEST", "Payload too large");
  await enforceRateLimit(`webhook:${provider}:ip:${ctx.ip ?? "unknown"}`, 1200, 60);

  const { secret, configRef } = await resolveSecret(provider, input.configId ?? null);
  const impl = getProvider(provider);

  let normalized: NormalizedEvent;
  try {
    if (!secret) throw new WebhookSignatureError("Webhook secret is not configured");
    normalized = impl.parseWebhook(rawBody, headers, secret, { toleranceSec: CASHFREE_WEBHOOK_TOLERANCE_SEC, now: input.now });
  } catch (e) {
    if (e instanceof WebhookSignatureError) {
      const sig = typeof (headers as Headers).get === "function" ? ((headers as Headers).get("x-razorpay-signature") ?? (headers as Headers).get("x-webhook-signature") ?? (headers as Headers).get("x-simulator-signature") ?? "") : "";
      const eventId = `invalid-${sha256Hex(`${rawBody}\n${sig}`)}`;
      try {
        await db.webhookEvent.create({
          data: { provider, eventId, eventType: "unverified", configRef, signatureValid: false, status: "FAILED", error: "Invalid signature", payload: { unverified: true, length: rawBody.length } },
        });
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
      }
      return { httpStatus: 401, result: "INVALID_SIGNATURE", eventId: null, outcome: null };
    }
    if (e instanceof AppError && e.code === "BAD_REQUEST") {
      return { httpStatus: 400, result: "BAD_REQUEST", eventId: null, outcome: null };
    }
    throw e;
  }

  // Signature verified from here on. Store (unique provider+eventId) so replays are acknowledged without reprocessing.
  let row: { id: string; status: string };
  try {
    const payload = { normalized, body: safeJson(rawBody) } as unknown as Prisma.InputJsonValue;
    row = await db.webhookEvent.create({
      data: { provider, eventId: normalized.eventId, eventType: normalized.eventType, configRef, signatureValid: true, status: "RECEIVED", payload },
      select: { id: true, status: true },
    });
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
    const existing = await db.webhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider, eventId: normalized.eventId } }, select: { id: true, status: true } });
    if (existing.status === "PROCESSED" || existing.status === "IGNORED") {
      return { httpStatus: 200, result: "DUPLICATE", eventId: normalized.eventId, outcome: null };
    }
    row = existing; // earlier delivery crashed or failed: retry processing
  }

  const res = await processStored(ctx, row.id);
  return {
    httpStatus: res.status === "FAILED" ? 500 : 200,
    result: res.status,
    eventId: normalized.eventId,
    outcome: res.outcome,
  };
}

/** Admin: process a stored, signature-verified event again (FAILED or IGNORED events). Never reprocesses unverified events. */
export async function reprocessWebhook(ctx: Ctx, input: unknown) {
  requireAdmin(ctx);
  const { id } = parse(z.object({ id: z.string().trim().min(1).max(64) }), input);
  const ev = await db.webhookEvent.findUnique({ where: { id } });
  if (!ev) throw notFound("Webhook event");
  if (!ev.signatureValid) throw new AppError("BAD_REQUEST", "This event failed signature verification and cannot be processed");
  if (ev.status === "PROCESSED") throw new AppError("CONFLICT", "This event was already processed");
  const res = await processStored(ctx, ev.id);
  await audit(ctx, { action: "webhook.reprocess", entityType: "WebhookEvent", entityId: ev.id, metadata: { provider: ev.provider, eventType: ev.eventType, result: res.status } });
  return { id: ev.id, status: res.status, outcome: res.outcome, error: res.error ?? null };
}
