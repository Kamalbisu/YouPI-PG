/**
 * Provider abstraction. Adapters are pure with respect to our database: they only talk HTTP to the
 * provider (through an injectable fetch) and verify signatures. All state changes happen in services.
 */
export type ProviderId = "RAZORPAY" | "CASHFREE" | "DEV_SIMULATOR";
export type ProviderMode = "TEST" | "LIVE";

/** Decrypted credentials. Never log, return or audit this object. */
export interface ProviderCredentials {
  keyId: string;
  secret: string;
  webhookSecret?: string | null;
  mode: ProviderMode;
}

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export interface CreateProviderOrderInput {
  /** Our unique reference for this provider order (orderCode plus attempt suffix). */
  receipt: string;
  amountMinor: number;
  currency: string;
  customer?: { name?: string | null; phone?: string | null; email?: string | null };
  /** Where the provider sends the browser after checkout (browser return is never proof of payment). */
  returnUrl?: string;
  notifyUrl?: string;
}

export interface ProviderOrder {
  providerOrderId: string;
  /** Cashfree payment_session_id. */
  sessionId?: string;
  /** Public key id that the browser SDK needs (Razorpay key id). Never a secret. */
  publicKeyId?: string;
}

export type NormalizedPaymentStatus = "SUCCEEDED" | "FAILED" | "PENDING" | "CANCELLED";

export interface NormalizedPayment {
  providerOrderId: string | null;
  providerPaymentId: string;
  status: NormalizedPaymentStatus;
  amountMinor: number;
  currency: string;
  method?: string | null;
  feeMinor?: number | null;
  feeTaxMinor?: number | null;
  failureReason?: string | null;
}

export type NormalizedRefundStatus = "PENDING" | "PROCESSED" | "FAILED";

export interface NormalizedRefund {
  providerRefundId: string;
  providerPaymentId: string | null;
  /** Our refundRef when the provider echoes it back (Cashfree refund_id, Razorpay notes / receipt). */
  refundRef?: string | null;
  status: NormalizedRefundStatus;
  amountMinor: number;
  failureReason?: string | null;
}

export type NormalizedEvent =
  | { kind: "payment"; eventId: string; eventType: string; payment: NormalizedPayment }
  | { kind: "refund"; eventId: string; eventType: string; refund: NormalizedRefund }
  | { kind: "ignored"; eventId: string; eventType: string };

export interface WebhookVerifyOptions {
  /** Cashfree only: maximum accepted age of x-webhook-timestamp, seconds. */
  toleranceSec?: number;
  now?: Date;
}

export interface PaymentProvider {
  readonly id: ProviderId;
  createProviderOrder(creds: ProviderCredentials, input: CreateProviderOrderInput): Promise<ProviderOrder>;
  /** Checkout-return signature (Razorpay). Providers without one return false. Constant-time. */
  verifyCheckoutSignature(creds: ProviderCredentials, input: { providerOrderId: string; providerPaymentId: string; signature: string }): boolean;
  /** Signature check only. Returns false for missing/invalid/stale. */
  verifyWebhookSignature(rawBody: string, headers: Headers | Record<string, string | undefined>, webhookSecret: string, opts?: WebhookVerifyOptions): boolean;
  /** Verifies the signature and normalises the payload. Throws WebhookSignatureError when invalid. */
  parseWebhook(rawBody: string, headers: Headers | Record<string, string | undefined>, webhookSecret: string, opts?: WebhookVerifyOptions): NormalizedEvent;
  /** Server-side status lookup. Returns the most relevant payment of the provider order, or null if none yet. */
  fetchPayment(creds: ProviderCredentials, input: { providerOrderId: string; providerPaymentId?: string | null }): Promise<NormalizedPayment | null>;
  createRefund(
    creds: ProviderCredentials,
    input: { providerPaymentId: string; providerOrderId?: string | null; amountMinor: number; refundRef: string; reason?: string | null },
  ): Promise<NormalizedRefund>;
  /** Harmless authenticated call used by "verify credentials". Throws AppError when rejected. */
  verifyCredentials(creds: ProviderCredentials): Promise<void>;
}

export class WebhookSignatureError extends Error {
  constructor(message = "Invalid webhook signature") {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

export function header(headers: Headers | Record<string, string | undefined>, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, string | undefined>)) if (k.toLowerCase() === lower) return v;
  return undefined;
}
