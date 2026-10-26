import { db } from "@/lib/db";
import { hmacSha256Base64, hmacSha256Hex } from "@/lib/crypto";
import { hashPassword } from "@/server/auth/password";
import type { Ctx } from "@/server/auth/types";
import { setProviderFetch, signSimulatorBody } from "@/server/payments";
import { createProduct } from "@/server/services/products";
import { createQr } from "@/server/services/qr";
import { createOrder } from "@/server/services/orders";
import { startPayment } from "@/server/services/checkout";
import { ingestWebhook } from "@/server/services/webhooks";
import { savePaymentConfig, setPaymentConfigActive } from "@/server/services/payment-config";
import { PASSWORD } from "./helpers";
import { ctxFromUser, makeAdminSession, makeTenant, type Tenant } from "./helpers-catalog";

export { makeAdminSession, makeTenant, req, seg, ctxFromUser } from "./helpers-catalog";
export type { Tenant } from "./helpers-catalog";

export const PAY_PERMISSIONS = ["products.manage", "offers.manage", "qr.manage", "payments.view", "payments.refund", "reports.export", "orders.manage"];

export const RZP_KEY = "rzp_test_abcdEFGH1234";
export const RZP_SECRET = "rzp_secret_value_1234567890";
export const RZP_WEBHOOK_SECRET = "rzp_whsec_value_1234567890";
export const CF_APP = "CFAPPID123456";
export const CF_SECRET = "cf_secret_value_1234567890";
export const CF_WEBHOOK_SECRET = "cf_whsec_value_1234567890";

let ipSeq = 10;
/** A fresh public IP per call so per-IP rate limits never couple tests. */
export const freshIp = () => `203.0.113.${(ipSeq = ipSeq >= 250 ? 10 : ipSeq + 1)}`;
export const customerCtx = (ip = freshIp()): Ctx => ({ actor: null, ip, userAgent: "vitest-customer" });

export async function code(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "NO_ERROR";
  } catch (e) {
    return (e as { code?: string }).code ?? `THROWN:${(e as Error).message}`;
  }
}

export interface Shop extends Tenant {
  manager: { id: string; email: string };
  managerCtx: Ctx;
  managerCookie: string;
  product: { id: string; priceMinor: number };
  qrToken: string;
  qrId: string;
}

/** Tenant with OWNER, a MANAGER (same client, non-owner membership), one product of INR 100.00 and a business QR. */
export async function makeShop(opts: { tag?: string; priceMinor?: number; permissions?: string[] } = {}): Promise<Shop> {
  const permissions = opts.permissions ?? PAY_PERMISSIONS;
  const t = await makeTenant({ permissions, tag: opts.tag });
  const manager = await db.user.create({
    data: {
      email: `manager-${t.client.id}@shop.test`,
      name: "Manager",
      role: "CLIENT",
      status: "ACTIVE",
      clientId: t.client.id,
      passwordHash: await hashPassword(PASSWORD),
    },
  });
  await db.businessMembership.create({ data: { userId: manager.id, businessId: t.business.id, role: "MANAGER" } });
  const m = await ctxFromUser(manager.id, "198.51.100.77");
  const product = (await createProduct(t.ctx, { businessId: t.business.id, name: "Masala Dosa", priceMinor: opts.priceMinor ?? 10000 })) as { id: string; priceMinor: number };
  const qr = (await createQr(t.ctx, { businessId: t.business.id, type: "BUSINESS", label: "Counter" })) as { id: string; token: string };
  return { ...t, manager, managerCtx: m.ctx, managerCookie: m.cookie, product, qrToken: qr.token, qrId: qr.id };
}

let keySeq = 0;
export const idemKey = (p = "k") => `${p}-${Date.now().toString(36)}-${++keySeq}-abcdef`;

export async function placeOrder(shop: Pick<Shop, "qrToken" | "product">, over: Record<string, unknown> = {}, ctx: Ctx = customerCtx()) {
  return createOrder(ctx, {
    qrToken: shop.qrToken,
    items: [{ productId: shop.product.id, quantity: 1 }],
    customer: { name: "Asha", email: "asha@example.com" },
    idempotencyKey: idemKey("ord"),
    ...over,
  });
}

/** Admin creates + activates a TEST config for a business and returns its id. */
export async function activateConfig(
  shop: Pick<Shop, "business">,
  provider: "RAZORPAY" | "CASHFREE" = "RAZORPAY",
  admin?: Ctx,
): Promise<{ configId: string; admin: Ctx }> {
  const adminCtx = admin ?? (await makeAdminSession()).ctx;
  const view = await savePaymentConfig(adminCtx, {
    businessId: shop.business.id,
    provider,
    mode: "TEST",
    keyId: provider === "RAZORPAY" ? RZP_KEY : CF_APP,
    secret: provider === "RAZORPAY" ? RZP_SECRET : CF_SECRET,
    webhookSecret: provider === "RAZORPAY" ? RZP_WEBHOOK_SECRET : CF_WEBHOOK_SECRET,
    methods: ["checkout", "upi_gpay"],
  });
  await setPaymentConfigActive(adminCtx, { id: view.id!, active: true });
  return { configId: view.id!, admin: adminCtx };
}

export interface FetchCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

/** Installs a provider HTTP mock. `respond` returns [status, json] for a call. Returns the call log. */
export function mockProviderHttp(respond?: (c: FetchCall) => [number, unknown] | undefined) {
  const calls: FetchCall[] = [];
  setProviderFetch(async (input, init) => {
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const headers: Record<string, string> = {};
    new Headers(init?.headers as HeadersInit | undefined).forEach((v, k) => (headers[k] = v));
    const call: FetchCall = { url: input, method: (init?.method ?? "GET").toUpperCase(), body, headers };
    calls.push(call);
    const custom = respond?.(call);
    const [status, json] = custom ?? defaultResponse(call);
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  });
  return calls;
}

let provSeq = 0;
function defaultResponse(c: FetchCall): [number, unknown] {
  const b = (c.body ?? {}) as Record<string, unknown>;
  if (c.url.includes("api.razorpay.com")) {
    if (c.method === "POST" && c.url.endsWith("/orders")) return [200, { id: `order_${++provSeq}test` }];
    if (c.url.includes("/refund")) return [200, { id: `rfnd_${++provSeq}test`, status: "processed", amount: b.amount }];
    if (c.url.endsWith("/orders") || c.url.includes("/payments")) return [200, { items: [] }];
    return [200, {}];
  }
  if (c.url.includes("cashfree.com")) {
    if (c.method === "POST" && c.url.endsWith("/orders")) return [200, { order_id: b.order_id, payment_session_id: `session_${++provSeq}` }];
    if (c.url.includes("/refunds")) return [200, { cf_refund_id: `cfr_${++provSeq}`, refund_status: "SUCCESS" }];
    if (c.url.includes("/payments")) return [200, []];
    return [200, {}];
  }
  return [404, {}];
}

export const stopProviderHttp = () => setProviderFetch(null);

/* ---------------------------- webhook builders ---------------------------- */

export interface WebhookRequest {
  rawBody: string;
  headers: Record<string, string>;
}

export function razorpayPaymentWebhook(
  o: { providerOrderId: string; paymentId: string; amountMinor: number; currency?: string; event?: "payment.captured" | "payment.failed"; eventId?: string; fee?: number; tax?: number },
  secret = RZP_WEBHOOK_SECRET,
): WebhookRequest {
  const event = o.event ?? "payment.captured";
  const rawBody = JSON.stringify({
    event,
    payload: {
      payment: {
        entity: {
          id: o.paymentId,
          order_id: o.providerOrderId,
          amount: o.amountMinor,
          currency: o.currency ?? "INR",
          status: event === "payment.captured" ? "captured" : "failed",
          method: "upi",
          fee: o.fee ?? 236,
          tax: o.tax ?? 36,
          error_description: event === "payment.failed" ? "Payment declined" : undefined,
        },
      },
    },
  });
  const headers: Record<string, string> = { "x-razorpay-signature": hmacSha256Hex(secret, rawBody) };
  if (o.eventId) headers["x-razorpay-event-id"] = o.eventId;
  return { rawBody, headers };
}

export function razorpayRefundWebhook(o: { paymentId: string; refundId: string; amountMinor: number; refundRef?: string; event?: "refund.processed" | "refund.failed" }, secret = RZP_WEBHOOK_SECRET): WebhookRequest {
  const event = o.event ?? "refund.processed";
  const rawBody = JSON.stringify({
    event,
    payload: { refund: { entity: { id: o.refundId, payment_id: o.paymentId, amount: o.amountMinor, status: event === "refund.processed" ? "processed" : "failed", notes: o.refundRef ? { refundRef: o.refundRef } : {} } } },
  });
  return { rawBody, headers: { "x-razorpay-signature": hmacSha256Hex(secret, rawBody) } };
}

export function cashfreePaymentWebhook(
  o: { providerOrderId: string; paymentId: string; amountMinor: number; currency?: string; success?: boolean; timestampMs?: number },
  secret = CF_WEBHOOK_SECRET,
): WebhookRequest & { timestamp: string } {
  const success = o.success ?? true;
  const rawBody = JSON.stringify({
    type: success ? "PAYMENT_SUCCESS_WEBHOOK" : "PAYMENT_FAILED_WEBHOOK",
    data: {
      order: { order_id: o.providerOrderId },
      payment: {
        cf_payment_id: o.paymentId,
        order_id: o.providerOrderId,
        payment_amount: o.amountMinor / 100,
        payment_currency: o.currency ?? "INR",
        payment_status: success ? "SUCCESS" : "FAILED",
        payment_group: "upi",
        payment_message: success ? "ok" : "declined",
      },
    },
  });
  const timestamp = String(o.timestampMs ?? Date.now());
  return { rawBody, timestamp, headers: { "x-webhook-signature": hmacSha256Base64(secret, timestamp + rawBody), "x-webhook-timestamp": timestamp } };
}

export function simulatorWebhook(o: {
  type?: "payment.success" | "payment.failed" | "payment.cancelled" | "refund.processed" | "refund.failed";
  eventId?: string;
  providerOrderId?: string;
  providerPaymentId?: string;
  amountMinor?: number;
  currency?: string;
  providerRefundId?: string;
  refundRef?: string;
}): WebhookRequest {
  const rawBody = JSON.stringify({ type: o.type ?? "payment.success", method: "simulator", currency: "INR", ...o });
  return { rawBody, headers: { "x-simulator-signature": signSimulatorBody(rawBody) } };
}

export function deliver(provider: "RAZORPAY" | "CASHFREE" | "DEV_SIMULATOR", w: WebhookRequest, extra: { configId?: string | null; now?: Date; ip?: string } = {}) {
  return ingestWebhook(customerCtx(extra.ip), { provider, rawBody: w.rawBody, headers: w.headers, configId: extra.configId ?? null, now: extra.now });
}

/** Order + open simulator attempt, ready to receive a signed event. */
export async function orderWithSimAttempt(shop: Pick<Shop, "qrToken" | "product">, over: Record<string, unknown> = {}) {
  const order = await placeOrder(shop, over);
  const start = await startPayment(customerCtx(), { publicId: order.publicId, provider: "DEV_SIMULATOR", method: "simulator", idempotencyKey: idemKey("pay") });
  return { order, start };
}

/** Order + open Razorpay attempt through the business config (mock HTTP must be installed). */
export async function orderWithRazorpayAttempt(shop: Shop, configId?: string, over: Record<string, unknown> = {}) {
  const order = await placeOrder(shop, over);
  const start = await startPayment(customerCtx(), { publicId: order.publicId, provider: "RAZORPAY", method: "checkout", idempotencyKey: idemKey("pay") });
  return { order, start, configId };
}

/** A paid order via the simulator path (same processing code as a webhook). */
export async function paidOrder(shop: Pick<Shop, "qrToken" | "product">, over: Record<string, unknown> = {}) {
  const { order, start } = await orderWithSimAttempt(shop, over);
  const w = simulatorWebhook({ providerOrderId: start.providerOrderId!, providerPaymentId: `sim_pay_${start.attemptId}`, amountMinor: order.totalMinor });
  const r = await deliver("DEV_SIMULATOR", w);
  const txn = await db.paymentTransaction.findFirstOrThrow({ where: { orderId: order.orderId } });
  return { order, start, txn, result: r };
}
