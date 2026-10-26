import { hmacSha256Hex, safeEqual, sha256Hex } from "@/lib/crypto";
import { AppError } from "@/lib/errors";
import { asObj, int, providerError, providerRequest, str } from "./http";
import {
  header,
  WebhookSignatureError,
  type FetchImpl,
  type NormalizedEvent,
  type NormalizedPayment,
  type NormalizedRefund,
  type PaymentProvider,
  type ProviderCredentials,
} from "./types";

const BASE = "https://api.razorpay.com/v1";
const NAME = "Razorpay";

const basic = (c: ProviderCredentials) => ({ authorization: `Basic ${Buffer.from(`${c.keyId}:${c.secret}`).toString("base64")}` });

function mapStatus(s: string | undefined): NormalizedPayment["status"] {
  switch (s) {
    case "captured":
      return "SUCCEEDED";
    case "failed":
      return "FAILED";
    default:
      return "PENDING"; // created, authorized (not captured), refunded handled elsewhere
  }
}

export function normalizeRazorpayPayment(p: Record<string, unknown>): NormalizedPayment | null {
  const id = str(p.id);
  const amount = int(p.amount);
  if (!id || amount === undefined) return null;
  // A fully refunded captured payment still reports status "refunded"; it was a successful capture.
  const status = p.status === "refunded" ? "SUCCEEDED" : mapStatus(str(p.status));
  return {
    providerOrderId: str(p.order_id) ?? null,
    providerPaymentId: id,
    status,
    amountMinor: amount,
    currency: (str(p.currency) ?? "INR").toUpperCase(),
    method: str(p.method) ?? null,
    feeMinor: int(p.fee) ?? null,
    feeTaxMinor: int(p.tax) ?? null,
    failureReason: status === "FAILED" ? (str(p.error_description) ?? str(p.error_reason) ?? "Payment failed") : null,
  };
}

function normalizeRazorpayRefund(r: Record<string, unknown>): NormalizedRefund | null {
  const id = str(r.id);
  const amount = int(r.amount);
  if (!id || amount === undefined) return null;
  const s = str(r.status);
  const notes = asObj(r.notes);
  return {
    providerRefundId: id,
    providerPaymentId: str(r.payment_id) ?? null,
    refundRef: str(notes.refundRef) ?? str(r.receipt) ?? null,
    status: s === "processed" ? "PROCESSED" : s === "failed" ? "FAILED" : "PENDING",
    amountMinor: amount,
    failureReason: s === "failed" ? "Refund failed at the provider" : null,
  };
}

export function createRazorpay(getFetch: () => FetchImpl): PaymentProvider {
  const verifyWebhookSignature: PaymentProvider["verifyWebhookSignature"] = (rawBody, headers, secret) => {
    const sig = header(headers, "x-razorpay-signature");
    if (!sig || !secret) return false;
    return safeEqual(hmacSha256Hex(secret, rawBody), sig);
  };

  return {
    id: "RAZORPAY",

    async createProviderOrder(creds, input) {
      const { status, json } = await providerRequest(getFetch(), NAME, {
        url: `${BASE}/orders`,
        method: "POST",
        headers: basic(creds),
        body: {
          amount: input.amountMinor,
          currency: input.currency,
          receipt: input.receipt.slice(0, 40),
          payment_capture: 1,
          notes: { receipt: input.receipt },
        },
      });
      const o = asObj(json);
      if (status < 200 || status >= 300) throw providerError(NAME, status, asObj(o.error).description);
      const id = str(o.id);
      if (!id) throw new AppError("PAYMENT_ERROR", "Razorpay returned an unexpected response");
      return { providerOrderId: id, publicKeyId: creds.keyId };
    },

    verifyCheckoutSignature(creds, { providerOrderId, providerPaymentId, signature }) {
      if (!signature || !creds.secret) return false;
      return safeEqual(hmacSha256Hex(creds.secret, `${providerOrderId}|${providerPaymentId}`), signature);
    },

    verifyWebhookSignature,

    parseWebhook(rawBody, headers, secret): NormalizedEvent {
      if (!verifyWebhookSignature(rawBody, headers, secret)) throw new WebhookSignatureError();
      let body: Record<string, unknown>;
      try {
        body = asObj(JSON.parse(rawBody));
      } catch {
        throw new AppError("BAD_REQUEST", "Webhook body is not valid JSON");
      }
      const eventType = str(body.event) ?? "unknown";
      const eventId = header(headers, "x-razorpay-event-id") ?? `body:${sha256Hex(rawBody)}`;
      const payload = asObj(body.payload);
      if (eventType === "payment.captured" || eventType === "payment.failed") {
        const p = normalizeRazorpayPayment(asObj(asObj(payload.payment).entity));
        if (p) {
          // The event type decides captured vs failed; the entity status is only a cross-check.
          if (eventType === "payment.captured" && p.status !== "SUCCEEDED") p.status = "SUCCEEDED";
          if (eventType === "payment.failed") p.status = "FAILED";
          return { kind: "payment", eventId, eventType, payment: p };
        }
      }
      if (eventType === "refund.processed" || eventType === "refund.failed" || eventType === "refund.created") {
        const r = normalizeRazorpayRefund(asObj(asObj(payload.refund).entity));
        if (r) {
          if (eventType === "refund.processed") r.status = "PROCESSED";
          else if (eventType === "refund.failed") r.status = "FAILED";
          else r.status = "PENDING";
          return { kind: "refund", eventId, eventType, refund: r };
        }
      }
      return { kind: "ignored", eventId, eventType };
    },

    async fetchPayment(creds, { providerOrderId, providerPaymentId }) {
      const url = providerPaymentId ? `${BASE}/payments/${encodeURIComponent(providerPaymentId)}` : `${BASE}/orders/${encodeURIComponent(providerOrderId)}/payments`;
      const { status, json } = await providerRequest(getFetch(), NAME, { url, method: "GET", headers: basic(creds) });
      if (status === 404) return null;
      const o = asObj(json);
      if (status < 200 || status >= 300) throw providerError(NAME, status, asObj(o.error).description);
      if (providerPaymentId) return normalizeRazorpayPayment(o);
      const items = (Array.isArray(o.items) ? o.items : []).map((x) => normalizeRazorpayPayment(asObj(x))).filter((x): x is NormalizedPayment => !!x);
      return items.find((p) => p.status === "SUCCEEDED") ?? items.find((p) => p.status === "PENDING") ?? items[0] ?? null;
    },

    async createRefund(creds, { providerPaymentId, amountMinor, refundRef, reason }) {
      const { status, json } = await providerRequest(getFetch(), NAME, {
        url: `${BASE}/payments/${encodeURIComponent(providerPaymentId)}/refund`,
        method: "POST",
        headers: basic(creds),
        body: { amount: amountMinor, speed: "normal", receipt: refundRef, notes: { refundRef, ...(reason ? { reason: reason.slice(0, 200) } : {}) } },
      });
      const o = asObj(json);
      if (status < 200 || status >= 300) throw providerError(NAME, status, asObj(o.error).description);
      const r = normalizeRazorpayRefund({ ...o, payment_id: o.payment_id ?? providerPaymentId });
      if (!r) throw new AppError("PAYMENT_ERROR", "Razorpay returned an unexpected refund response");
      return { ...r, refundRef: r.refundRef ?? refundRef };
    },

    async verifyCredentials(creds) {
      const { status, json } = await providerRequest(getFetch(), NAME, { url: `${BASE}/orders?count=1`, method: "GET", headers: basic(creds) });
      if (status < 200 || status >= 300) throw providerError(NAME, status, asObj(asObj(json).error).description);
    },
  };
}
