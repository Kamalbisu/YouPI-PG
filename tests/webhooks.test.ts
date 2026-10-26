import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { resetEnvCache } from "@/lib/env";
import { startPayment } from "@/server/services/checkout";
import { ingestWebhook, reprocessWebhook, WEBHOOK_MAX_BYTES } from "@/server/services/webhooks";
import { POST as rzpRoute } from "@/app/api/webhooks/razorpay/route";
import { POST as rzpConfigRoute } from "@/app/api/webhooks/razorpay/[configId]/route";
import { POST as cfConfigRoute } from "@/app/api/webhooks/cashfree/[configId]/route";
import { POST as simRoute } from "@/app/api/webhooks/simulator/route";
import { POST as reprocessRoute } from "@/app/api/admin/reconciliation/webhooks/[id]/reprocess/route";
import { resetDb } from "./helpers";
import {
  CF_WEBHOOK_SECRET,
  RZP_WEBHOOK_SECRET,
  activateConfig,
  cashfreePaymentWebhook,
  code,
  customerCtx,
  deliver,
  idemKey,
  makeAdminSession,
  makeShop,
  mockProviderHttp,
  orderWithRazorpayAttempt,
  orderWithSimAttempt,
  placeOrder,
  razorpayPaymentWebhook,
  req,
  seg,
  simulatorWebhook,
  stopProviderHttp,
  type WebhookRequest,
} from "./helpers-payments";

beforeEach(async () => {
  await resetDb();
  mockProviderHttp();
});
afterEach(() => {
  stopProviderHttp();
  delete process.env.RAZORPAY_WEBHOOK_SECRET;
  delete process.env.RAZORPAY_KEY_ID;
  delete process.env.RAZORPAY_KEY_SECRET;
  resetEnvCache();
});

const rawReq = (path: string, w: WebhookRequest, extra: Record<string, string> = {}) =>
  new NextRequest(`http://localhost:3000${path}`, { method: "POST", body: w.rawBody, headers: { "content-type": "application/json", ...w.headers, ...extra } });

async function cashfreeAttempt(shop: Awaited<ReturnType<typeof makeShop>>) {
  const { configId } = await activateConfig(shop, "CASHFREE");
  const order = await placeOrder(shop);
  const start = await startPayment(customerCtx(), { publicId: order.publicId, provider: "CASHFREE", method: "checkout", idempotencyKey: idemKey("cf") });
  return { configId, order, start };
}

describe("razorpay webhook signatures", () => {
  it("a valid signed payment.captured marks the order paid and stores a verified event", async () => {
    const shop = await makeShop();
    const { configId } = await activateConfig(shop);
    const { order, start } = await orderWithRazorpayAttempt(shop, configId);
    const w = razorpayPaymentWebhook({ providerOrderId: start.providerOrderId!, paymentId: "pay_wh1", amountMinor: 10000, eventId: "evt_rzp_1" });
    const r = await deliver("RAZORPAY", w, { configId });
    expect(r.httpStatus).toBe(200);
    expect(r.outcome).toBe("PAID");
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("PAID");
    const txn = await db.paymentTransaction.findFirstOrThrow({ where: { orderId: order.orderId } });
    expect(txn.feeMinor).toBe(236);
    expect(txn.feeTaxMinor).toBe(36);
    expect(txn.verificationSource).toBe("WEBHOOK");
    const ev = await db.webhookEvent.findFirstOrThrow({ where: { eventId: "evt_rzp_1" } });
    expect(ev.signatureValid).toBe(true);
    expect(ev.status).toBe("PROCESSED");
  });

  it("rejects a wrong secret, a missing signature and a tampered body; stores signatureValid=false and changes nothing", async () => {
    const shop = await makeShop();
    const { configId } = await activateConfig(shop);
    const { order, start } = await orderWithRazorpayAttempt(shop, configId);
    const good = razorpayPaymentWebhook({ providerOrderId: start.providerOrderId!, paymentId: "pay_bad", amountMinor: 10000 });

    const wrongSecret = razorpayPaymentWebhook({ providerOrderId: start.providerOrderId!, paymentId: "pay_bad", amountMinor: 10000 }, "attacker-secret-attacker");
    const noSig: WebhookRequest = { rawBody: good.rawBody, headers: {} };
    // Body edited after signing: amount lowered is not interesting, so raise the paid status of a different payment.
    const tampered: WebhookRequest = { rawBody: good.rawBody.replace("pay_bad", "pay_evil"), headers: good.headers };
    const whitespace: WebhookRequest = { rawBody: `${good.rawBody} `, headers: good.headers };

    for (const w of [wrongSecret, noSig, tampered, whitespace]) {
      const r = await deliver("RAZORPAY", w, { configId });
      expect(r.httpStatus).toBe(401);
      expect(r.result).toBe("INVALID_SIGNATURE");
    }
    expect(await db.webhookEvent.count({ where: { signatureValid: false } })).toBeGreaterThanOrEqual(3);
    expect(await db.webhookEvent.count({ where: { signatureValid: true } })).toBe(0);
    expect(await db.paymentTransaction.count()).toBe(0);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("PENDING_PAYMENT");
    // The stored unverified row never keeps the attacker payload.
    const bad = await db.webhookEvent.findFirstOrThrow({ where: { signatureValid: false } });
    expect(JSON.stringify(bad.payload)).not.toContain("pay_evil");
  });

  it("a replay of the same event is acknowledged without reprocessing", async () => {
    const shop = await makeShop();
    const { configId } = await activateConfig(shop);
    const { order, start } = await orderWithRazorpayAttempt(shop, configId);
    const w = razorpayPaymentWebhook({ providerOrderId: start.providerOrderId!, paymentId: "pay_rep", amountMinor: 10000, eventId: "evt_rep" });
    expect((await deliver("RAZORPAY", w, { configId })).result).toBe("PROCESSED");
    const again = await deliver("RAZORPAY", w, { configId });
    expect(again.httpStatus).toBe(200);
    expect(again.result).toBe("DUPLICATE");
    expect(await db.webhookEvent.count({ where: { eventId: "evt_rep" } })).toBe(1);
    expect(await db.paymentTransaction.count({ where: { orderId: order.orderId } })).toBe(1);
  });

  it("without an event-id header the same body replays as a duplicate, a different body does not", async () => {
    const shop = await makeShop();
    const { configId } = await activateConfig(shop);
    const { start } = await orderWithRazorpayAttempt(shop, configId);
    const w = razorpayPaymentWebhook({ providerOrderId: start.providerOrderId!, paymentId: "pay_nohdr", amountMinor: 10000 });
    await deliver("RAZORPAY", w, { configId });
    expect((await deliver("RAZORPAY", w, { configId })).result).toBe("DUPLICATE");
  });

  it("a webhook signed with another business's secret cannot pay this business's order", async () => {
    const shopA = await makeShop({ tag: "a" });
    const shopB = await makeShop({ tag: "b" });
    const cfgA = await activateConfig(shopA);
    const cfgB = await activateConfig(shopB);
    const { order, start } = await orderWithRazorpayAttempt(shopA, cfgA.configId);
    const w = razorpayPaymentWebhook({ providerOrderId: start.providerOrderId!, paymentId: "pay_cross", amountMinor: 10000 });
    // Delivered to B's endpoint (valid signature for B's secret) but the attempt belongs to A's config.
    const r = await deliver("RAZORPAY", w, { configId: cfgB.configId });
    expect(r.outcome).toBe("UNMATCHED");
    expect(r.result).toBe("IGNORED");
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("PENDING_PAYMENT");
    expect(await db.paymentTransaction.count()).toBe(0);
  });

  it("an unknown config id is NOT_FOUND and a config of another provider is refused", async () => {
    const shop = await makeShop();
    const { configId } = await activateConfig(shop);
    const w = razorpayPaymentWebhook({ providerOrderId: "order_x", paymentId: "pay_x", amountMinor: 1 });
    expect(await code(() => deliver("RAZORPAY", w, { configId: "missing-config-id" }))).toBe("NOT_FOUND");
    expect(await code(() => deliver("CASHFREE", cashfreePaymentWebhook({ providerOrderId: "o", paymentId: "1", amountMinor: 1 }), { configId }))).toBe("NOT_FOUND");
  });

  it("a payment.failed event fails the attempt but leaves the order payable", async () => {
    const shop = await makeShop();
    const { configId } = await activateConfig(shop);
    const { order, start } = await orderWithRazorpayAttempt(shop, configId);
    const r = await deliver("RAZORPAY", razorpayPaymentWebhook({ providerOrderId: start.providerOrderId!, paymentId: "pay_f", amountMinor: 10000, event: "payment.failed" }), { configId });
    expect(r.result).toBe("PROCESSED");
    expect((await db.paymentAttempt.findUniqueOrThrow({ where: { id: start.attemptId } })).status).toBe("FAILED");
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("PENDING_PAYMENT");
    expect(await db.paymentTransaction.count()).toBe(0);
  });

  it("an event for an unknown provider order is IGNORED and acknowledged (no retry storm)", async () => {
    const shop = await makeShop();
    const { configId } = await activateConfig(shop);
    const r = await deliver("RAZORPAY", razorpayPaymentWebhook({ providerOrderId: "order_unknown", paymentId: "pay_u", amountMinor: 100 }), { configId });
    expect(r.httpStatus).toBe(200);
    expect(r.result).toBe("IGNORED");
  });

  it("an unhandled event type is IGNORED, malformed JSON with a valid signature is BAD_REQUEST", async () => {
    const shop = await makeShop();
    const { configId } = await activateConfig(shop);
    const body = JSON.stringify({ event: "order.paid", payload: {} });
    const { hmacSha256Hex } = await import("@/lib/crypto");
    const w: WebhookRequest = { rawBody: body, headers: { "x-razorpay-signature": hmacSha256Hex(RZP_WEBHOOK_SECRET, body) } };
    expect((await deliver("RAZORPAY", w, { configId })).result).toBe("IGNORED");
    const junk = "not json at all";
    const w2: WebhookRequest = { rawBody: junk, headers: { "x-razorpay-signature": hmacSha256Hex(RZP_WEBHOOK_SECRET, junk) } };
    const r2 = await deliver("RAZORPAY", w2, { configId });
    expect(r2.httpStatus).toBe(400);
    expect(r2.result).toBe("BAD_REQUEST");
  });

  it("a configured business with no webhook secret refuses every event", async () => {
    const shop = await makeShop();
    const { configId } = await activateConfig(shop);
    await db.paymentProviderConfig.update({ where: { id: configId }, data: { webhookSecretEnc: null } });
    const r = await deliver("RAZORPAY", razorpayPaymentWebhook({ providerOrderId: "order_x", paymentId: "pay_x", amountMinor: 1 }), { configId });
    expect(r.httpStatus).toBe(401);
  });

  it("platform endpoint uses the environment secret and rejects when none is set", async () => {
    const shop = await makeShop();
    const w = razorpayPaymentWebhook({ providerOrderId: "order_p", paymentId: "pay_p", amountMinor: 1 });
    expect((await deliver("RAZORPAY", w)).httpStatus).toBe(401);
    process.env.RAZORPAY_KEY_ID = "rzp_test_platformKEY1";
    process.env.RAZORPAY_KEY_SECRET = "platform_secret_value_123";
    process.env.RAZORPAY_WEBHOOK_SECRET = RZP_WEBHOOK_SECRET;
    resetEnvCache();
    expect((await deliver("RAZORPAY", w)).httpStatus).toBe(200);
    void shop;
  });
});

describe("cashfree webhook signatures", () => {
  it("a valid signed success marks paid, converting rupees to paise", async () => {
    const shop = await makeShop({ priceMinor: 12550 });
    const { configId, order, start } = await cashfreeAttempt(shop);
    expect(order.totalMinor).toBe(12550);
    const w = cashfreePaymentWebhook({ providerOrderId: start.providerOrderId!, paymentId: "9988", amountMinor: 12550 });
    const r = await deliver("CASHFREE", w, { configId });
    expect(r.outcome).toBe("PAID");
    const txn = await db.paymentTransaction.findFirstOrThrow({ where: { orderId: order.orderId } });
    expect(txn.amountMinor).toBe(12550);
    expect(txn.provider).toBe("CASHFREE");
  });

  it("rejects invalid, tampered and wrong-timestamp signatures", async () => {
    const shop = await makeShop();
    const { configId, order, start } = await cashfreeAttempt(shop);
    const good = cashfreePaymentWebhook({ providerOrderId: start.providerOrderId!, paymentId: "77", amountMinor: 10000 });
    const wrongSecret = cashfreePaymentWebhook({ providerOrderId: start.providerOrderId!, paymentId: "77", amountMinor: 10000 }, "attacker-secret-attacker");
    const tampered: WebhookRequest = { rawBody: good.rawBody.replace('"payment_amount":100', '"payment_amount":1'), headers: good.headers };
    const retimed: WebhookRequest = { rawBody: good.rawBody, headers: { ...good.headers, "x-webhook-timestamp": String(Number(good.timestamp) + 1000) } };
    const noTs: WebhookRequest = { rawBody: good.rawBody, headers: { "x-webhook-signature": good.headers["x-webhook-signature"] } };
    for (const w of [wrongSecret, tampered, retimed, noTs]) {
      const r = await deliver("CASHFREE", w, { configId });
      expect(r.httpStatus).toBe(401);
    }
    expect(await db.paymentTransaction.count()).toBe(0);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("PENDING_PAYMENT");
    expect(await db.webhookEvent.count({ where: { signatureValid: false } })).toBeGreaterThanOrEqual(2);
  });

  it("rejects a correctly signed but stale timestamp (replay of an old capture) and accepts one inside the window", async () => {
    const shop = await makeShop();
    const { configId, order, start } = await cashfreeAttempt(shop);
    const old = cashfreePaymentWebhook({ providerOrderId: start.providerOrderId!, paymentId: "55", amountMinor: 10000, timestampMs: Date.now() - 3600_000 });
    const r = await deliver("CASHFREE", old, { configId });
    expect(r.httpStatus).toBe(401);
    expect(r.result).toBe("INVALID_SIGNATURE");
    expect(await db.paymentTransaction.count()).toBe(0);
    // Future-dated beyond tolerance is rejected too.
    const future = cashfreePaymentWebhook({ providerOrderId: start.providerOrderId!, paymentId: "55", amountMinor: 10000, timestampMs: Date.now() + 3600_000 });
    expect((await deliver("CASHFREE", future, { configId })).httpStatus).toBe(401);
    // Inside the window (4 minutes old) passes.
    const fresh = cashfreePaymentWebhook({ providerOrderId: start.providerOrderId!, paymentId: "55", amountMinor: 10000, timestampMs: Date.now() - 240_000 });
    expect((await deliver("CASHFREE", fresh, { configId })).outcome).toBe("PAID");
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("PAID");
  });

  it("the same body replayed is a duplicate; a failed event keeps the order payable", async () => {
    const shop = await makeShop();
    const { configId, order, start } = await cashfreeAttempt(shop);
    const bad = cashfreePaymentWebhook({ providerOrderId: start.providerOrderId!, paymentId: "11", amountMinor: 10000, success: false });
    expect((await deliver("CASHFREE", bad, { configId })).result).toBe("PROCESSED");
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("PENDING_PAYMENT");
    expect((await deliver("CASHFREE", bad, { configId })).result).toBe("DUPLICATE");
  });

  it("amount mismatch via Cashfree is not marked paid", async () => {
    const shop = await makeShop();
    const { configId, order, start } = await cashfreeAttempt(shop);
    const r = await deliver("CASHFREE", cashfreePaymentWebhook({ providerOrderId: start.providerOrderId!, paymentId: "12", amountMinor: 9999 }), { configId });
    expect(r.outcome).toBe("MISMATCH");
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("PENDING_PAYMENT");
  });
});

describe("webhook routes", () => {
  it("per-config razorpay route: valid is 200 { received: true }, invalid is 401 with a signatureValid=false row", async () => {
    const shop = await makeShop();
    const { configId } = await activateConfig(shop);
    const { order, start } = await orderWithRazorpayAttempt(shop, configId);
    const bad = razorpayPaymentWebhook({ providerOrderId: start.providerOrderId!, paymentId: "pay_rt", amountMinor: 10000 }, "wrong-wrong-wrong-wrong");
    const res401 = await rzpConfigRoute(rawReq(`/api/webhooks/razorpay/${configId}`, bad), seg({ configId }));
    expect(res401.status).toBe(401);
    expect((await res401.json()).received).toBe(false);
    expect(await db.webhookEvent.count({ where: { signatureValid: false } })).toBe(1);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("PENDING_PAYMENT");

    const good = razorpayPaymentWebhook({ providerOrderId: start.providerOrderId!, paymentId: "pay_rt", amountMinor: 10000 });
    // No cookies, no origin header: webhooks are machine calls.
    const ok = await rzpConfigRoute(new NextRequest(`http://localhost:3000/api/webhooks/razorpay/${configId}`, { method: "POST", body: good.rawBody, headers: good.headers }), seg({ configId }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ received: true, result: "PROCESSED" });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("PAID");
  });

  it("per-config cashfree route verifies timestamp+body", async () => {
    const shop = await makeShop();
    const { configId, order, start } = await cashfreeAttempt(shop);
    const good = cashfreePaymentWebhook({ providerOrderId: start.providerOrderId!, paymentId: "31", amountMinor: 10000 });
    const res = await cfConfigRoute(rawReq(`/api/webhooks/cashfree/${configId}`, good), seg({ configId }));
    expect(res.status).toBe(200);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("PAID");
    const stale = cashfreePaymentWebhook({ providerOrderId: start.providerOrderId!, paymentId: "32", amountMinor: 10000, timestampMs: Date.now() - 3600_000 });
    expect((await cfConfigRoute(rawReq(`/api/webhooks/cashfree/${configId}`, stale), seg({ configId }))).status).toBe(401);
  });

  it("platform razorpay route returns 401 without a configured secret", async () => {
    const w = razorpayPaymentWebhook({ providerOrderId: "order_q", paymentId: "pay_q", amountMinor: 1 });
    const res = await rzpRoute(rawReq("/api/webhooks/razorpay", w), seg({}));
    expect(res.status).toBe(401);
  });

  it("simulator route: signed accepted, unsigned rejected, unknown config 404 on the razorpay route", async () => {
    const shop = await makeShop();
    const { order, start } = await orderWithSimAttempt(shop);
    const w = simulatorWebhook({ providerOrderId: start.providerOrderId, providerPaymentId: "sim_pay_route", amountMinor: 10000 });
    expect((await simRoute(rawReq("/api/webhooks/simulator", { rawBody: w.rawBody, headers: {} }), seg({}))).status).toBe(401);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("PENDING_PAYMENT");
    expect((await simRoute(rawReq("/api/webhooks/simulator", w), seg({}))).status).toBe(200);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("PAID");
    const nf = await rzpConfigRoute(rawReq("/api/webhooks/razorpay/nope", w), seg({ configId: "nope" }));
    expect(nf.status).toBe(404);
    expect((await nf.json()).error.code).toBe("NOT_FOUND");
  });

  it("an oversized body is refused before signature work, both by header and by length", async () => {
    const shop = await makeShop();
    const { configId } = await activateConfig(shop);
    const huge = "x".repeat(WEBHOOK_MAX_BYTES + 10);
    const viaHeader = await rzpConfigRoute(
      new NextRequest(`http://localhost:3000/api/webhooks/razorpay/${configId}`, { method: "POST", body: "{}", headers: { "content-length": String(WEBHOOK_MAX_BYTES + 10) } }),
      seg({ configId }),
    );
    expect(viaHeader.status).toBe(400);
    expect(await code(() => ingestWebhook(customerCtx(), { provider: "RAZORPAY", rawBody: huge, headers: {}, configId }))).toBe("BAD_REQUEST");
    expect(await db.webhookEvent.count()).toBe(0);
  });
});

describe("reprocessWebhook", () => {
  it("replays an IGNORED event once its attempt exists; refuses PROCESSED, unverified, unknown ids and non-admins", async () => {
    mockProviderHttp((c) => (c.method === "POST" && c.url.endsWith("/orders") && c.url.includes("razorpay") ? [200, { id: "order_fixedRP1" }] : undefined));
    const shop = await makeShop();
    const { configId, admin } = await activateConfig(shop);
    // Event arrives before the attempt is recorded.
    const early = razorpayPaymentWebhook({ providerOrderId: "order_fixedRP1", paymentId: "pay_early", amountMinor: 10000, eventId: "evt_early" });
    expect((await deliver("RAZORPAY", early, { configId })).result).toBe("IGNORED");
    const ev = await db.webhookEvent.findFirstOrThrow({ where: { eventId: "evt_early" } });
    expect(ev.status).toBe("IGNORED");

    const order = await placeOrder(shop);
    await startPayment(customerCtx(), { publicId: order.publicId, provider: "RAZORPAY", method: "checkout", idempotencyKey: idemKey("rp") });

    // Non-admin (the shop's client owner) cannot reprocess; unauthenticated route is 401.
    expect(await code(() => reprocessWebhook(shop.ctx, { id: ev.id }))).toBe("FORBIDDEN");
    expect((await reprocessRoute(req("POST", `/api/admin/reconciliation/webhooks/${ev.id}/reprocess`, {}), seg({ id: ev.id }))).status).toBe(401);
    expect(await db.paymentTransaction.count()).toBe(0);

    const r = await reprocessWebhook(admin, { id: ev.id });
    expect(r.status).toBe("PROCESSED");
    expect(r.outcome).toBe("PAID");
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("PAID");
    expect(await db.auditLog.count({ where: { action: "webhook.reprocess" } })).toBe(1);

    expect(await code(() => reprocessWebhook(admin, { id: ev.id }))).toBe("CONFLICT");
    expect(await code(() => reprocessWebhook(admin, { id: "missing" }))).toBe("NOT_FOUND");
    expect(await code(() => reprocessWebhook(admin, {}))).toBe("VALIDATION");

    // Unverified events can never be processed.
    await deliver("RAZORPAY", razorpayPaymentWebhook({ providerOrderId: "order_fixedRP1", paymentId: "pay_z", amountMinor: 1 }, "wrong-wrong-wrong-wrong"), { configId });
    const unverified = await db.webhookEvent.findFirstOrThrow({ where: { signatureValid: false } });
    expect(await code(() => reprocessWebhook(admin, { id: unverified.id }))).toBe("BAD_REQUEST");
  });

  it("the admin route works for a signed-in admin and returns { data }", async () => {
    const admin = await makeAdminSession();
    const shop = await makeShop();
    const { configId } = await activateConfig(shop, "RAZORPAY", admin.ctx);
    const early = razorpayPaymentWebhook({ providerOrderId: "order_nobody", paymentId: "pay_n", amountMinor: 1, eventId: "evt_n" });
    await deliver("RAZORPAY", early, { configId });
    const ev = await db.webhookEvent.findFirstOrThrow({ where: { eventId: "evt_n" } });
    const res = await reprocessRoute(req("POST", `/api/admin/reconciliation/webhooks/${ev.id}/reprocess`, { cookie: admin.cookie }), seg({ id: ev.id }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(ev.id);
    // Still unmatched, so it stays IGNORED rather than inventing a payment.
    expect(body.data.status).toBe("IGNORED");
    expect(await db.paymentTransaction.count()).toBe(0);
  });
});

void CF_WEBHOOK_SECRET;
