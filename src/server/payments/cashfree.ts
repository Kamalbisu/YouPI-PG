import { hmacSha256Base64, safeEqual, sha256Hex } from "@/lib/crypto";
import { AppError } from "@/lib/errors";
import { minorToMajorString, parseMajorToMinor } from "@/lib/money";
import { asObj, providerError, providerRequest, str } from "./http";
import {
  header,
  WebhookSignatureError,
  type FetchImpl,
  type NormalizedEvent,
  type NormalizedPayment,
  type NormalizedRefund,
  type PaymentProvider,
  type ProviderCredentials,
  type UpiIntent,
} from "./types";

const NAME = "Cashfree";
const API_VERSION = "2023-08-01";
export const CASHFREE_WEBHOOK_TOLERANCE_SEC = 300;

const base = (c: ProviderCredentials) => (c.mode === "LIVE" ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg");
const auth = (c: ProviderCredentials) => ({ "x-client-id": c.keyId, "x-client-secret": c.secret, "x-api-version": API_VERSION });

/** Cashfree amounts are decimal rupees (number or string). Converted without float drift. */
function toMinor(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return parseMajorToMinor(v.toFixed(2)) ?? undefined;
  if (typeof v === "string") return parseMajorToMinor(v) ?? undefined;
  return undefined;
}

function mapMethod(p: Record<string, unknown>): string | null {
  const g = str(p.payment_group);
  if (g) return g.toLowerCase().replace(/_/g, "");
  const m = Object.keys(asObj(p.payment_method))[0];
  return m ?? null;
}

function mapStatus(s: string | undefined): NormalizedPayment["status"] {
  switch (s) {
    case "SUCCESS":
      return "SUCCEEDED";
    case "FAILED":
      return "FAILED";
    case "USER_DROPPED":
    case "CANCELLED":
    case "VOID":
      return "CANCELLED";
    default:
      return "PENDING"; // NOT_ATTEMPTED, PENDING, FLAGGED
  }
}

export function normalizeCashfreePayment(p: Record<string, unknown>, orderId?: string): NormalizedPayment | null {
  const id = str(p.cf_payment_id);
  const amount = toMinor(p.payment_amount);
  if (!id || amount === undefined) return null;
  const status = mapStatus(str(p.payment_status));
  return {
    providerOrderId: str(p.order_id) ?? orderId ?? null,
    providerPaymentId: id,
    status,
    amountMinor: amount,
    currency: (str(p.payment_currency) ?? "INR").toUpperCase(),
    method: mapMethod(p),
    failureReason: status === "FAILED" || status === "CANCELLED" ? (str(p.payment_message) ?? str(asObj(p.error_details).error_description) ?? null) : null,
  };
}

function normalizeCashfreeRefund(r: Record<string, unknown>): NormalizedRefund | null {
  const id = str(r.cf_refund_id) ?? str(r.refund_id);
  const amount = toMinor(r.refund_amount);
  if (!id || amount === undefined) return null;
  const s = str(r.refund_status);
  return {
    providerRefundId: id,
    providerPaymentId: str(r.cf_payment_id) ?? null,
    refundRef: str(r.refund_id) ?? null,
    status: s === "SUCCESS" ? "PROCESSED" : s === "CANCELLED" || s === "FAILED" ? "FAILED" : "PENDING",
    amountMinor: amount,
    failureReason: s === "CANCELLED" || s === "FAILED" ? (str(r.status_description) ?? "Refund was not completed") : null,
  };
}

export function createCashfree(getFetch: () => FetchImpl): PaymentProvider {
  const verifyWebhookSignature: PaymentProvider["verifyWebhookSignature"] = (rawBody, headers, secret, opts) => {
    const sig = header(headers, "x-webhook-signature");
    const ts = header(headers, "x-webhook-timestamp");
    if (!sig || !ts || !secret) return false;
    // The timestamp is part of the signed payload, so it cannot be altered; reject stale ones to blunt replay.
    const n = Number(ts);
    if (!Number.isFinite(n)) return false;
    const tsMs = n < 1e12 ? n * 1000 : n; // seconds or milliseconds
    const now = (opts?.now ?? new Date()).getTime();
    const tol = (opts?.toleranceSec ?? CASHFREE_WEBHOOK_TOLERANCE_SEC) * 1000;
    if (Math.abs(now - tsMs) > tol) return false;
    return safeEqual(hmacSha256Base64(secret, ts + rawBody), sig);
  };

  return {
    id: "CASHFREE",

    async createProviderOrder(creds, input) {
      const phone = (input.customer?.phone ?? "").replace(/\D/g, "").slice(-10);
      const { status, json } = await providerRequest(getFetch(), NAME, {
        url: `${base(creds)}/orders`,
        method: "POST",
        headers: auth(creds),
        body: {
          order_id: input.receipt,
          order_amount: Number(minorToMajorString(input.amountMinor)),
          order_currency: input.currency,
          customer_details: {
            customer_id: `cust_${input.receipt}`.slice(0, 50),
            customer_phone: phone.length === 10 ? phone : "9999999999",
            ...(input.customer?.name ? { customer_name: input.customer.name.slice(0, 100) } : {}),
            ...(input.customer?.email ? { customer_email: input.customer.email } : {}),
          },
          order_meta: { ...(input.returnUrl ? { return_url: input.returnUrl } : {}), ...(input.notifyUrl ? { notify_url: input.notifyUrl } : {}) },
        },
      });
      const o = asObj(json);
      if (status < 200 || status >= 300) throw providerError(NAME, status, o.message);
      const id = str(o.order_id);
      const session = str(o.payment_session_id);
      if (!id || !session) throw new AppError("PAYMENT_ERROR", "Cashfree returned an unexpected response");
      return { providerOrderId: id, sessionId: session };
    },

    /**
     * Order Pay with UPI channel "link": returns the upi:// intent (plus app links) for the payment session.
     * Only upi: URIs are accepted so a malformed provider answer can never put another scheme in front of the customer.
     */
    async createUpiIntent(creds, { sessionId }): Promise<UpiIntent> {
      const { status, json } = await providerRequest(getFetch(), NAME, {
        url: `${base(creds)}/orders/sessions`,
        method: "POST",
        headers: auth(creds),
        body: { payment_session_id: sessionId, payment_method: { upi: { channel: "link" } } },
      });
      const o = asObj(json);
      if (status < 200 || status >= 300) throw providerError(NAME, status, o.message);
      const payload = asObj(asObj(o.data).payload);
      const ok = (v: unknown) => (typeof v === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(v) && v.length < 2000 ? v : undefined);
      const uri = ok(payload.default) ?? ok(payload.web);
      if (!uri || !uri.toLowerCase().startsWith("upi://")) throw new AppError("PAYMENT_ERROR", "Cashfree did not return a UPI payment link");
      const appLinks: UpiIntent["appLinks"] = {};
      for (const k of ["gpay", "phonepe", "paytm", "bhim", "cred"] as const) {
        const v = ok(payload[k]);
        if (v) appLinks[k] = v;
      }
      return { uri, appLinks };
    },

    // Cashfree has no browser-return signature; the result must come from a webhook or a server-side fetch.
    verifyCheckoutSignature: () => false,

    verifyWebhookSignature,

    parseWebhook(rawBody, headers, secret, opts): NormalizedEvent {
      if (!verifyWebhookSignature(rawBody, headers, secret, opts)) throw new WebhookSignatureError();
      let body: Record<string, unknown>;
      try {
        body = asObj(JSON.parse(rawBody));
      } catch {
        throw new AppError("BAD_REQUEST", "Webhook body is not valid JSON");
      }
      const eventType = str(body.type) ?? "unknown";
      const eventId = `body:${sha256Hex(rawBody)}`;
      const data = asObj(body.data);
      const orderId = str(asObj(data.order).order_id);
      if (eventType === "PAYMENT_SUCCESS_WEBHOOK" || eventType === "PAYMENT_FAILED_WEBHOOK" || eventType === "PAYMENT_USER_DROPPED_WEBHOOK") {
        const p = normalizeCashfreePayment(asObj(data.payment), orderId);
        if (p) {
          if (eventType === "PAYMENT_SUCCESS_WEBHOOK") p.status = "SUCCEEDED";
          else if (eventType === "PAYMENT_FAILED_WEBHOOK") p.status = "FAILED";
          else p.status = "CANCELLED";
          return { kind: "payment", eventId, eventType, payment: p };
        }
      }
      if (eventType === "REFUND_STATUS_WEBHOOK") {
        const r = normalizeCashfreeRefund(asObj(data.refund));
        if (r) return { kind: "refund", eventId, eventType, refund: r };
      }
      return { kind: "ignored", eventId, eventType };
    },

    async fetchPayment(creds, { providerOrderId, providerPaymentId }) {
      const { status, json } = await providerRequest(getFetch(), NAME, {
        url: `${base(creds)}/orders/${encodeURIComponent(providerOrderId)}/payments`,
        method: "GET",
        headers: auth(creds),
      });
      if (status === 404) return null;
      if (status < 200 || status >= 300) throw providerError(NAME, status, asObj(json).message);
      const items = (Array.isArray(json) ? json : [])
        .map((x) => normalizeCashfreePayment(asObj(x), providerOrderId))
        .filter((x): x is NormalizedPayment => !!x)
        .filter((p) => !providerPaymentId || p.providerPaymentId === providerPaymentId);
      return items.find((p) => p.status === "SUCCEEDED") ?? items.find((p) => p.status === "PENDING") ?? items[0] ?? null;
    },

    async createRefund(creds, { providerOrderId, providerPaymentId, amountMinor, refundRef, reason }) {
      if (!providerOrderId) throw new AppError("BAD_REQUEST", "Provider order is missing for this transaction");
      const { status, json } = await providerRequest(getFetch(), NAME, {
        url: `${base(creds)}/orders/${encodeURIComponent(providerOrderId)}/refunds`,
        method: "POST",
        headers: auth(creds),
        body: { refund_amount: Number(minorToMajorString(amountMinor)), refund_id: refundRef, ...(reason ? { refund_note: reason.slice(0, 200) } : {}) },
      });
      const o = asObj(json);
      if (status < 200 || status >= 300) throw providerError(NAME, status, o.message);
      const r = normalizeCashfreeRefund({ ...o, cf_payment_id: o.cf_payment_id ?? providerPaymentId, refund_amount: o.refund_amount ?? Number(minorToMajorString(amountMinor)) });
      if (!r) throw new AppError("PAYMENT_ERROR", "Cashfree returned an unexpected refund response");
      return { ...r, refundRef };
    },

    async verifyCredentials(creds) {
      // An unknown order id answers 404 only when the credentials are valid; bad credentials answer 401.
      const { status, json } = await providerRequest(getFetch(), NAME, { url: `${base(creds)}/orders/youpi_credential_check`, method: "GET", headers: auth(creds) });
      if (status === 404 || (status >= 200 && status < 300)) return;
      throw providerError(NAME, status, asObj(json).message);
    },
  };
}
