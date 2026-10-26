import { hmacSha256Hex, safeEqual, sha256Hex } from "@/lib/crypto";
import { AppError } from "@/lib/errors";
import { env, simulatorEnabled } from "@/lib/env";
import { randomToken } from "@/lib/ids";
import { asObj, int, str } from "./http";
import { header, WebhookSignatureError, type NormalizedEvent, type PaymentProvider } from "./types";

/**
 * Development-only provider. It never talks to a network. Completion is delivered as an internally
 * signed event (HMAC with a key derived from APP_SECRET) that goes through the same verification and
 * processing path as a real webhook. Every entry point refuses unless simulatorEnabled() is true,
 * and simulatorEnabled() is false whenever NODE_ENV=production.
 */
export const SIMULATOR_SIGNATURE_HEADER = "x-simulator-signature";

export function assertSimulator(): void {
  if (!simulatorEnabled()) throw new AppError("FORBIDDEN", "The payment simulator is not available");
}

/** Webhook/event signing key. Derived, never stored, never returned. */
export function simulatorSecret(): string {
  const base = env().APP_SECRET;
  if (!base) throw new Error("APP_SECRET is not set");
  return hmacSha256Hex(base, "payment-simulator-v1");
}

export function signSimulatorBody(rawBody: string): string {
  assertSimulator();
  return hmacSha256Hex(simulatorSecret(), rawBody);
}

export const simulator: PaymentProvider = {
  id: "DEV_SIMULATOR",

  async createProviderOrder(_creds, input) {
    assertSimulator();
    return { providerOrderId: `sim_order_${randomToken(9)}`, publicKeyId: "simulator", sessionId: `sim_${input.receipt}` };
  },

  verifyCheckoutSignature() {
    return false; // The simulator has no browser-return signature; results arrive as signed events.
  },

  verifyWebhookSignature(rawBody, headers) {
    if (!simulatorEnabled()) return false;
    const sig = header(headers, SIMULATOR_SIGNATURE_HEADER);
    if (!sig) return false;
    return safeEqual(hmacSha256Hex(simulatorSecret(), rawBody), sig);
  },

  parseWebhook(rawBody, headers, secret): NormalizedEvent {
    if (!this.verifyWebhookSignature(rawBody, headers, secret)) throw new WebhookSignatureError();
    let body: Record<string, unknown>;
    try {
      body = asObj(JSON.parse(rawBody));
    } catch {
      throw new AppError("BAD_REQUEST", "Event body is not valid JSON");
    }
    const eventType = str(body.type) ?? "unknown";
    const eventId = str(body.eventId) ?? `body:${sha256Hex(rawBody)}`;
    if (eventType === "payment.success" || eventType === "payment.failed" || eventType === "payment.cancelled") {
      const amount = int(body.amountMinor);
      const paymentId = str(body.providerPaymentId);
      if (amount !== undefined && paymentId) {
        return {
          kind: "payment",
          eventId,
          eventType,
          payment: {
            providerOrderId: str(body.providerOrderId) ?? null,
            providerPaymentId: paymentId,
            status: eventType === "payment.success" ? "SUCCEEDED" : eventType === "payment.failed" ? "FAILED" : "CANCELLED",
            amountMinor: amount,
            currency: (str(body.currency) ?? "INR").toUpperCase(),
            method: str(body.method) ?? "simulator",
            feeMinor: 0,
            feeTaxMinor: 0,
            failureReason: eventType === "payment.success" ? null : (str(body.reason) ?? "Simulated payment did not complete"),
          },
        };
      }
    }
    if (eventType === "refund.processed" || eventType === "refund.failed") {
      const amount = int(body.amountMinor);
      const refundId = str(body.providerRefundId);
      if (amount !== undefined && refundId) {
        return {
          kind: "refund",
          eventId,
          eventType,
          refund: {
            providerRefundId: refundId,
            providerPaymentId: str(body.providerPaymentId) ?? null,
            refundRef: str(body.refundRef) ?? null,
            status: eventType === "refund.processed" ? "PROCESSED" : "FAILED",
            amountMinor: amount,
            failureReason: eventType === "refund.failed" ? "Simulated refund failed" : null,
          },
        };
      }
    }
    return { kind: "ignored", eventId, eventType };
  },

  // The simulator keeps no remote state; polling cannot learn anything it was not already told by an event.
  async fetchPayment() {
    assertSimulator();
    return null;
  },

  async createRefund(_creds, { providerPaymentId, amountMinor, refundRef }) {
    assertSimulator();
    return { providerRefundId: `sim_refund_${randomToken(9)}`, providerPaymentId, refundRef, status: "PROCESSED", amountMinor, failureReason: null };
  },

  async verifyCredentials() {
    assertSimulator();
  },
};
