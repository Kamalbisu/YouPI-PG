import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { hmacSha256Hex } from "@/lib/crypto";
import { env, resetEnvCache } from "@/lib/env";
import { startPayment, getPaymentOptions, cancelAttempt } from "@/server/services/checkout";
import { applyPaymentEvent, expireStaleOrders, getPaymentStatus, refreshPaymentStatus, verifyCheckoutReturn } from "@/server/services/payment-verification";
import { savePaymentConfig, setPaymentConfigActive } from "@/server/services/payment-config";
import { simulatorComplete } from "@/server/services/checkout";
import { signSimulatorBody } from "@/server/payments";
import { POST as startRoute } from "@/app/api/pay/[publicId]/start/route";
import { POST as verifyRoute } from "@/app/api/pay/[publicId]/verify/route";
import { GET as optionsRoute } from "@/app/api/pay/[publicId]/options/route";
import { GET as statusRoute } from "@/app/api/pay/[publicId]/status/route";
import { POST as simulateRoute } from "@/app/api/pay/[publicId]/simulate/route";
import { POST as cronRoute } from "@/app/api/cron/expire/route";
import { resetDb } from "./helpers";
import {
  RZP_KEY,
  RZP_SECRET,
  RZP_WEBHOOK_SECRET,
  activateConfig,
  code,
  customerCtx,
  deliver,
  idemKey,
  makeAdminSession,
  makeShop,
  mockProviderHttp,
  orderWithRazorpayAttempt,
  orderWithSimAttempt,
  paidOrder,
  placeOrder,
  req,
  seg,
  simulatorWebhook,
  stopProviderHttp,
} from "./helpers-payments";

const ENV_KEYS = ["NODE_ENV", "PAYMENT_SIMULATOR_ENABLED", "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "CRON_SECRET"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  await resetDb();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else (process.env as Record<string, string | undefined>)[k] = savedEnv[k];
  }
  resetEnvCache();
  stopProviderHttp();
});

const setEnv = (k: (typeof ENV_KEYS)[number], v: string | undefined) => {
  if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
  else (process.env as Record<string, string | undefined>)[k] = v;
  resetEnvCache();
};

describe("payment options and provider selection", () => {
  it("offers only the simulator when the business has no provider configured", async () => {
    const shop = await makeShop();
    const o = await placeOrder(shop);
    const opts = await getPaymentOptions(o.publicId);
    expect(opts.payable).toBe(true);
    expect(opts.options.map((x) => x.provider)).toEqual(["DEV_SIMULATOR"]);
    expect(opts.totalMinor).toBe(10000);
  });

  it("offers the enabled methods of an ACTIVE business config and nothing for an inactive one", async () => {
    mockProviderHttp();
    const shop = await makeShop();
    const admin = (await makeAdminSession()).ctx;
    const view = await savePaymentConfig(admin, { businessId: shop.business.id, provider: "RAZORPAY", mode: "TEST", keyId: RZP_KEY, secret: RZP_SECRET, webhookSecret: RZP_WEBHOOK_SECRET, methods: ["checkout", "upi_gpay"] });
    const o = await placeOrder(shop);
    expect((await getPaymentOptions(o.publicId)).options.some((x) => x.provider === "RAZORPAY")).toBe(false);
    await setPaymentConfigActive(admin, { id: view.id!, active: true });
    const after = await getPaymentOptions(o.publicId);
    expect(after.options.filter((x) => x.provider === "RAZORPAY").map((x) => x.method).sort()).toEqual(["checkout", "upi_gpay"]);
    await setPaymentConfigActive(admin, { id: view.id!, active: false });
    expect((await getPaymentOptions(o.publicId)).options.some((x) => x.provider === "RAZORPAY")).toBe(false);
  });

  it("falls back to platform env credentials only when the business has no config row", async () => {
    setEnv("RAZORPAY_KEY_ID", "rzp_test_platformKEY1");
    setEnv("RAZORPAY_KEY_SECRET", "platform_secret_value_123");
    const shop = await makeShop();
    const o = await placeOrder(shop);
    expect((await getPaymentOptions(o.publicId)).options.some((x) => x.provider === "RAZORPAY")).toBe(true);
    // A deactivated row of its own means no fallback.
    const admin = (await makeAdminSession()).ctx;
    await savePaymentConfig(admin, { businessId: shop.business.id, provider: "RAZORPAY", mode: "TEST", keyId: RZP_KEY, secret: RZP_SECRET, methods: ["checkout"] });
    expect((await getPaymentOptions(o.publicId)).options.some((x) => x.provider === "RAZORPAY")).toBe(false);
  });

  it("is not payable for expired, cancelled or suspended-business orders", async () => {
    const shop = await makeShop();
    const expired = await placeOrder(shop);
    await db.order.update({ where: { id: expired.orderId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const o1 = await getPaymentOptions(expired.publicId);
    expect(o1.payable).toBe(false);
    expect(o1.options).toEqual([]);
    const susp = await placeOrder(shop);
    await db.business.update({ where: { id: shop.business.id }, data: { status: "SUSPENDED" } });
    expect((await getPaymentOptions(susp.publicId)).payable).toBe(false);
    expect(await code(() => startPayment(customerCtx(), { publicId: susp.publicId, provider: "DEV_SIMULATOR", method: "simulator", idempotencyKey: idemKey() }))).toBe("CONFLICT");
  });

  it("returns NOT_FOUND for an unknown public id", async () => {
    expect(await code(() => getPaymentOptions("does-not-exist-xyz"))).toBe("NOT_FOUND");
  });

  it("options route returns { data } and never any secret", async () => {
    const shop = await makeShop();
    await activateConfig(shop);
    const o = await placeOrder(shop);
    const res = await optionsRoute(req("GET", `/api/pay/${o.publicId}/options`), seg({ publicId: o.publicId }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(RZP_SECRET);
    expect(text).not.toContain(RZP_WEBHOOK_SECRET);
    expect(JSON.parse(text).data.options.length).toBeGreaterThan(0);
  });
});

describe("startPayment", () => {
  it("creates the provider order from the DB amount and returns only public data", async () => {
    const calls = mockProviderHttp();
    const shop = await makeShop({ priceMinor: 25000 });
    await activateConfig(shop);
    const o = await placeOrder(shop, { items: [{ productId: shop.product.id, quantity: 2 }] });
    const r = await startPayment(customerCtx(), { publicId: o.publicId, provider: "RAZORPAY", method: "checkout", idempotencyKey: idemKey() });
    expect(r.checkoutKind).toBe("razorpay_checkout");
    expect(r.publicKeyId).toBe(RZP_KEY);
    expect(r.amountMinor).toBe(50000);
    expect(r.providerOrderId).toMatch(/^order_/);
    expect(JSON.stringify(r)).not.toContain(RZP_SECRET);
    const created = calls.find((c) => c.url.endsWith("/orders") && c.method === "POST")!;
    expect((created.body as { amount: number }).amount).toBe(50000);
    expect(created.headers.authorization).toMatch(/^Basic /);
  });

  it("ignores a client supplied amount in the start input", async () => {
    mockProviderHttp();
    const shop = await makeShop();
    await activateConfig(shop);
    const o = await placeOrder(shop);
    const r = await startPayment(customerCtx(), { publicId: o.publicId, provider: "RAZORPAY", method: "checkout", amountMinor: 1, idempotencyKey: idemKey() });
    expect(r.amountMinor).toBe(10000);
  });

  it("is idempotent per key and keeps one open attempt when called concurrently", async () => {
    mockProviderHttp();
    const shop = await makeShop();
    await activateConfig(shop);
    const o = await placeOrder(shop);
    const key = idemKey("same");
    const [a, b] = await Promise.allSettled([
      startPayment(customerCtx(), { publicId: o.publicId, provider: "RAZORPAY", method: "checkout", idempotencyKey: key }),
      startPayment(customerCtx(), { publicId: o.publicId, provider: "RAZORPAY", method: "checkout", idempotencyKey: key }),
    ]);
    const ok = [a, b].filter((x) => x.status === "fulfilled") as PromiseFulfilledResult<{ attemptId: string }>[];
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const open = await db.paymentAttempt.count({ where: { orderId: o.orderId, status: { in: ["CREATED", "PENDING", "AUTHORIZED"] } } });
    expect(open).toBe(1);
    const again = await startPayment(customerCtx(), { publicId: o.publicId, provider: "RAZORPAY", method: "checkout", idempotencyKey: key });
    expect(again.replayed).toBe(true);
    expect(again.attemptId).toBe(ok[0].value.attemptId);
  });

  it("different keys and different methods replace the older open attempt (never two open)", async () => {
    mockProviderHttp();
    const shop = await makeShop();
    await activateConfig(shop);
    const o = await placeOrder(shop);
    const first = await startPayment(customerCtx(), { publicId: o.publicId, provider: "RAZORPAY", method: "checkout", idempotencyKey: idemKey() });
    const second = await startPayment(customerCtx(), { publicId: o.publicId, provider: "RAZORPAY", method: "upi_gpay", idempotencyKey: idemKey() });
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(second.upiApp).toBe("gpay");
    const open = await db.paymentAttempt.findMany({ where: { orderId: o.orderId, status: { in: ["CREATED", "PENDING", "AUTHORIZED"] } } });
    expect(open.map((x) => x.id)).toEqual([second.attemptId]);
  });

  it("rejects a method that is not enabled, an unknown provider pairing, and a bad key", async () => {
    mockProviderHttp();
    const shop = await makeShop();
    await activateConfig(shop);
    const o = await placeOrder(shop);
    expect(await code(() => startPayment(customerCtx(), { publicId: o.publicId, provider: "RAZORPAY", method: "upi_paytm", idempotencyKey: idemKey() }))).toBe("BAD_REQUEST");
    expect(await code(() => startPayment(customerCtx(), { publicId: o.publicId, provider: "CASHFREE", method: "checkout", idempotencyKey: idemKey() }))).toBe("BAD_REQUEST");
    expect(await code(() => startPayment(customerCtx(), { publicId: o.publicId, provider: "RAZORPAY", method: "simulator", idempotencyKey: idemKey() }))).toBe("VALIDATION");
    expect(await code(() => startPayment(customerCtx(), { publicId: o.publicId, provider: "RAZORPAY", method: "checkout", idempotencyKey: "x" }))).toBe("VALIDATION");
  });

  it("marks the attempt failed and reports PROVIDER error when the provider is down", async () => {
    mockProviderHttp(() => [500, { error: { description: "down" } }]);
    const shop = await makeShop();
    await activateConfig(shop);
    const o = await placeOrder(shop);
    const c = await code(() => startPayment(customerCtx(), { publicId: o.publicId, provider: "RAZORPAY", method: "checkout", idempotencyKey: idemKey() }));
    expect(["PAYMENT_ERROR", "PROVIDER_UNAVAILABLE"]).toContain(c);
    const at = await db.paymentAttempt.findFirstOrThrow({ where: { orderId: o.orderId } });
    expect(at.status).toBe("FAILED");
    expect((await db.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe("PENDING_PAYMENT");
    // The customer can try again.
    mockProviderHttp();
    const ok = await startPayment(customerCtx(), { publicId: o.publicId, provider: "RAZORPAY", method: "checkout", idempotencyKey: idemKey() });
    expect(ok.providerOrderId).toMatch(/^order_/);
  });

  it("cancelAttempt closes only the open attempt and never the order", async () => {
    const shop = await makeShop();
    const { order, start } = await orderWithSimAttempt(shop);
    expect((await cancelAttempt(customerCtx(), { publicId: order.publicId, attemptId: start.attemptId })).cancelled).toBe(true);
    expect((await cancelAttempt(customerCtx(), { publicId: order.publicId, attemptId: start.attemptId })).cancelled).toBe(false);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("PENDING_PAYMENT");
    expect(await code(() => cancelAttempt(customerCtx(), { publicId: order.publicId, attemptId: "nope" }))).toBe("NOT_FOUND");
  });

  it("start route returns { data } and rejects bad bodies with the error shape", async () => {
    const shop = await makeShop();
    const o = await placeOrder(shop);
    const ok = await startRoute(req("POST", `/api/pay/${o.publicId}/start`, { body: { provider: "DEV_SIMULATOR", method: "simulator", idempotencyKey: idemKey() } }), seg({ publicId: o.publicId }));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.data.checkoutKind).toBe("simulator");
    expect(body.data.attemptId).toBeTruthy();
    const bad = await startRoute(req("POST", `/api/pay/${o.publicId}/start`, { body: { provider: "NOPE" } }), seg({ publicId: o.publicId }));
    expect(bad.status).toBe(422);
    expect((await bad.json()).error.code).toBe("VALIDATION");
  });
});

describe("payment integrity", () => {
  it("a verified simulator payment marks the order paid and creates one transaction", async () => {
    const shop = await makeShop();
    const { order, txn, result } = await paidOrder(shop);
    expect(result.result).toBe("PROCESSED");
    expect(result.outcome).toBe("PAID");
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("PAID");
    expect(txn.status).toBe("SUCCEEDED");
    expect(txn.amountMinor).toBe(10000);
    expect(txn.isDuplicate).toBe(false);
    expect(txn.verificationSource).toBe("WEBHOOK");
    const st = await getPaymentStatus(order.publicId);
    expect(st.paymentState).toBe("SUCCEEDED");
    expect(st.txnRef).toBe(txn.txnRef);
  });

  it("amount mismatch does not mark the order paid, fails the attempt and is flagged", async () => {
    const shop = await makeShop();
    const { order, start } = await orderWithSimAttempt(shop);
    const r = await deliver("DEV_SIMULATOR", simulatorWebhook({ providerOrderId: start.providerOrderId, providerPaymentId: "sim_pay_short", amountMinor: 100 }));
    expect(r.outcome).toBe("MISMATCH");
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("PENDING_PAYMENT");
    expect(await db.paymentTransaction.count({ where: { orderId: order.orderId } })).toBe(0);
    const at = await db.paymentAttempt.findUniqueOrThrow({ where: { id: start.attemptId } });
    expect(at.status).toBe("FAILED");
    expect(at.failureReason).toMatch(/Amount mismatch/);
    expect(await db.auditLog.count({ where: { action: "payment.mismatch" } })).toBe(1);
    expect((await getPaymentStatus(order.publicId)).paymentState).not.toBe("SUCCEEDED");
  });

  it("currency mismatch is treated as a mismatch even when the amount matches", async () => {
    const shop = await makeShop();
    const { order, start } = await orderWithSimAttempt(shop);
    const r = await deliver("DEV_SIMULATOR", simulatorWebhook({ providerOrderId: start.providerOrderId, providerPaymentId: "sim_pay_usd", amountMinor: 10000, currency: "USD" }));
    expect(r.outcome).toBe("MISMATCH");
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("PENDING_PAYMENT");
    expect(await db.paymentTransaction.count()).toBe(0);
  });

  it("a mismatch webhook replay does not write a second audit entry", async () => {
    const shop = await makeShop();
    const { start } = await orderWithSimAttempt(shop);
    const w = simulatorWebhook({ providerOrderId: start.providerOrderId, providerPaymentId: "sim_pay_short2", amountMinor: 5, eventId: "evt_m1" });
    await deliver("DEV_SIMULATOR", w);
    const r2 = await deliver("DEV_SIMULATOR", w);
    expect(r2.result).toBe("DUPLICATE");
    expect(await db.auditLog.count({ where: { action: "payment.mismatch" } })).toBe(1);
  });

  it("a browser redirect without proof never marks the order paid", async () => {
    mockProviderHttp();
    const shop = await makeShop();
    const { configId } = await activateConfig(shop);
    const { order, start } = await orderWithRazorpayAttempt(shop, configId);
    // The "status" endpoint and refresh (provider reports nothing) must leave it unpaid.
    const st = await refreshPaymentStatus(order.publicId);
    expect(st.paymentState).not.toBe("SUCCEEDED");
    const res = await statusRoute(req("GET", `/api/pay/${order.publicId}/status`), seg({ publicId: order.publicId }));
    expect((await res.json()).data.orderStatus).toBe("PENDING_PAYMENT");
    // Forged signature on the verify endpoint.
    const bad = await verifyRoute(
      req("POST", `/api/pay/${order.publicId}/verify`, { body: { providerOrderId: start.providerOrderId, providerPaymentId: "pay_forged", signature: "deadbeef" } }),
      seg({ publicId: order.publicId }),
    );
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("BAD_REQUEST");
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("PENDING_PAYMENT");
    expect(await db.paymentTransaction.count()).toBe(0);
  });

  it("the simulate route cannot mark an order paid without a matching attempt", async () => {
    const shop = await makeShop();
    const o = await placeOrder(shop);
    const res = await simulateRoute(req("POST", `/api/pay/${o.publicId}/simulate`, { body: { attemptId: "not-an-attempt", outcome: "success" } }), seg({ publicId: o.publicId }));
    expect(res.status).toBe(404);
    expect((await db.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe("PENDING_PAYMENT");
  });

  it("valid Razorpay checkout signature verifies, marks paid, and is idempotent on repeat", async () => {
    mockProviderHttp();
    const shop = await makeShop();
    const { configId } = await activateConfig(shop);
    const { order, start } = await orderWithRazorpayAttempt(shop, configId);
    const sig = hmacSha256Hex(RZP_SECRET, `${start.providerOrderId}|pay_good1`);
    const st = await verifyCheckoutReturn(customerCtx(), { publicId: order.publicId, providerOrderId: start.providerOrderId, providerPaymentId: "pay_good1", signature: sig });
    expect(st.paymentState).toBe("SUCCEEDED");
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("PAID");
    const txn = await db.paymentTransaction.findFirstOrThrow({ where: { orderId: order.orderId } });
    expect(txn.verificationSource).toBe("CHECKOUT_SIGNATURE");
    expect(txn.amountMinor).toBe(10000);
    // Same proof again: still one transaction.
    await verifyCheckoutReturn(customerCtx(), { publicId: order.publicId, providerOrderId: start.providerOrderId, providerPaymentId: "pay_good1", signature: sig });
    expect(await db.paymentTransaction.count({ where: { orderId: order.orderId } })).toBe(1);
  });

  it("rejects a checkout signature for a different payment id, a signature from the wrong secret, and another order's attempt", async () => {
    mockProviderHttp();
    const shop = await makeShop();
    const { configId } = await activateConfig(shop);
    const a = await orderWithRazorpayAttempt(shop, configId);
    const b = await orderWithRazorpayAttempt(shop, configId);
    const goodSigA = hmacSha256Hex(RZP_SECRET, `${a.start.providerOrderId}|pay_a`);
    // payment id tampered after signing
    expect(await code(() => verifyCheckoutReturn(customerCtx(), { publicId: a.order.publicId, providerOrderId: a.start.providerOrderId, providerPaymentId: "pay_other", signature: goodSigA }))).toBe("BAD_REQUEST");
    // wrong secret
    const wrong = hmacSha256Hex("not-the-secret", `${a.start.providerOrderId}|pay_a`);
    expect(await code(() => verifyCheckoutReturn(customerCtx(), { publicId: a.order.publicId, providerOrderId: a.start.providerOrderId, providerPaymentId: "pay_a", signature: wrong }))).toBe("BAD_REQUEST");
    // order A's signed proof replayed against order B's public id
    expect(await code(() => verifyCheckoutReturn(customerCtx(), { publicId: b.order.publicId, providerOrderId: a.start.providerOrderId, providerPaymentId: "pay_a", signature: goodSigA }))).toBe("NOT_FOUND");
    expect(await db.paymentTransaction.count()).toBe(0);
  });

  it("when the provider fetch reports a failed payment a valid signature does not mark the order paid", async () => {
    const shop = await makeShop();
    const { configId } = await activateConfig(shop);
    mockProviderHttp((c) => {
      if (c.url.includes("/payments/pay_decl")) return [200, { id: "pay_decl", order_id: "x", amount: 10000, currency: "INR", status: "failed", method: "card", error_description: "declined" }];
      return undefined;
    });
    const { order, start } = await orderWithRazorpayAttempt(shop, configId);
    // re-mock so the fetched payment has the real provider order id
    mockProviderHttp((c) => {
      if (c.url.includes("/payments/pay_decl")) return [200, { id: "pay_decl", order_id: start.providerOrderId, amount: 10000, currency: "INR", status: "failed", method: "card", error_description: "declined" }];
      return undefined;
    });
    const sig = hmacSha256Hex(RZP_SECRET, `${start.providerOrderId}|pay_decl`);
    const st = await verifyCheckoutReturn(customerCtx(), { publicId: order.publicId, providerOrderId: start.providerOrderId, providerPaymentId: "pay_decl", signature: sig });
    expect(st.paymentState).toBe("FAILED");
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("PENDING_PAYMENT");
    expect(await db.paymentTransaction.count()).toBe(0);
  });

  it("refreshPaymentStatus picks up a captured payment from the provider (API_FETCH) and is idempotent", async () => {
    const shop = await makeShop();
    const { configId } = await activateConfig(shop);
    mockProviderHttp();
    const { order, start } = await orderWithRazorpayAttempt(shop, configId);
    mockProviderHttp((c) => {
      if (c.method === "GET" && c.url.includes(`/orders/${start.providerOrderId}/payments`)) {
        return [200, { items: [{ id: "pay_fetch1", order_id: start.providerOrderId, amount: 10000, currency: "INR", status: "captured", method: "upi", fee: 236, tax: 36 }] }];
      }
      return undefined;
    });
    const st = await refreshPaymentStatus(order.publicId);
    expect(st.paymentState).toBe("SUCCEEDED");
    const txn = await db.paymentTransaction.findFirstOrThrow({ where: { orderId: order.orderId } });
    expect(txn.verificationSource).toBe("API_FETCH");
    expect(txn.feeMinor).toBe(236);
    await refreshPaymentStatus(order.publicId);
    expect(await db.paymentTransaction.count({ where: { orderId: order.orderId } })).toBe(1);
  });

  it("a provider outage during refresh keeps the current state and does not throw", async () => {
    const shop = await makeShop();
    const { configId } = await activateConfig(shop);
    mockProviderHttp();
    const { order } = await orderWithRazorpayAttempt(shop, configId);
    mockProviderHttp(() => [503, {}]);
    const st = await refreshPaymentStatus(order.publicId);
    expect(st.orderStatus).toBe("PENDING_PAYMENT");
  });

  it("processing the same verified payment twice yields one transaction and ALREADY_RECORDED", async () => {
    const shop = await makeShop();
    const { order, start } = await orderWithSimAttempt(shop);
    const payment = { providerOrderId: start.providerOrderId, providerPaymentId: "sim_pay_twice", status: "SUCCEEDED" as const, amountMinor: 10000, currency: "INR", method: "simulator" };
    const a = await applyPaymentEvent(customerCtx(), { provider: "DEV_SIMULATOR", payment, source: "WEBHOOK" });
    const b = await applyPaymentEvent(customerCtx(), { provider: "DEV_SIMULATOR", payment, source: "API_FETCH" });
    expect(a.outcome).toBe("PAID");
    expect(b.outcome).toBe("ALREADY_RECORDED");
    expect(await db.paymentTransaction.count({ where: { orderId: order.orderId } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: "payment.verified" } })).toBe(1);
  });

  it("concurrent identical deliveries produce a single transaction", async () => {
    const shop = await makeShop();
    const { order, start } = await orderWithSimAttempt(shop);
    const payment = { providerOrderId: start.providerOrderId, providerPaymentId: "sim_pay_conc", status: "SUCCEEDED" as const, amountMinor: 10000, currency: "INR", method: "simulator" };
    const results = await Promise.all([1, 2, 3, 4].map(() => applyPaymentEvent(customerCtx(), { provider: "DEV_SIMULATOR", payment, source: "WEBHOOK" })));
    expect(results.filter((r) => r.outcome === "PAID").length).toBe(1);
    expect(results.filter((r) => r.outcome === "ALREADY_RECORDED").length).toBe(3);
    expect(await db.paymentTransaction.count({ where: { orderId: order.orderId } })).toBe(1);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("PAID");
  });

  it("two different payments for one order: exactly one is the real payment, the other is flagged isDuplicate", async () => {
    const shop = await makeShop();
    const { order, start } = await orderWithSimAttempt(shop);
    const mk = (id: string) => ({ providerOrderId: start.providerOrderId, providerPaymentId: id, status: "SUCCEEDED" as const, amountMinor: 10000, currency: "INR", method: "simulator" });
    const results = await Promise.all([applyPaymentEvent(customerCtx(), { provider: "DEV_SIMULATOR", payment: mk("sim_pay_x1"), source: "WEBHOOK" }), applyPaymentEvent(customerCtx(), { provider: "DEV_SIMULATOR", payment: mk("sim_pay_x2"), source: "WEBHOOK" })]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["DUPLICATE", "PAID"]);
    const txns = await db.paymentTransaction.findMany({ where: { orderId: order.orderId } });
    expect(txns.length).toBe(2);
    expect(txns.filter((t) => t.isDuplicate).length).toBe(1);
    expect(txns.filter((t) => !t.isDuplicate).length).toBe(1);
    expect(await db.auditLog.count({ where: { action: "payment.duplicate" } })).toBe(1);
  });

  it("a late payment on an expired order is recorded, the order becomes PAID and it is flagged", async () => {
    const shop = await makeShop();
    const { order, start } = await orderWithSimAttempt(shop);
    const swept = await expireStaleOrders(new Date(Date.now() + 3 * 3600_000));
    expect(swept.expired).toBe(1);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("EXPIRED");
    expect((await db.paymentAttempt.findUniqueOrThrow({ where: { id: start.attemptId } })).status).toBe("CANCELLED");
    const r = await deliver("DEV_SIMULATOR", simulatorWebhook({ providerOrderId: start.providerOrderId, providerPaymentId: "sim_pay_late", amountMinor: 10000 }));
    expect(r.outcome).toBe("LATE_PAID");
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("PAID");
    const txn = await db.paymentTransaction.findFirstOrThrow({ where: { orderId: order.orderId } });
    expect(txn.isDuplicate).toBe(false);
    expect(await db.auditLog.count({ where: { action: "payment.late" } })).toBe(1);
  });

  it("a failure event never overrides a success", async () => {
    const shop = await makeShop();
    const { order, start, txn } = await paidOrder(shop);
    await deliver("DEV_SIMULATOR", simulatorWebhook({ type: "payment.failed", providerOrderId: start.providerOrderId, providerPaymentId: `sim_pay_${start.attemptId}`, amountMinor: 10000 }));
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("PAID");
    expect((await db.paymentAttempt.findUniqueOrThrow({ where: { id: start.attemptId } })).status).toBe("SUCCEEDED");
    expect((await db.paymentTransaction.findUniqueOrThrow({ where: { id: txn.id } })).status).toBe("SUCCEEDED");
  });

  it("a failed payment keeps the order payable and the customer can retry", async () => {
    const shop = await makeShop();
    const { order, start } = await orderWithSimAttempt(shop);
    const sc = await simulatorComplete(order.publicId, start.attemptId, "failure");
    expect(sc.status.paymentState).toBe("FAILED");
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("PENDING_PAYMENT");
    const retry = await startPayment(customerCtx(), { publicId: order.publicId, provider: "DEV_SIMULATOR", method: "simulator", idempotencyKey: idemKey() });
    expect(retry.attemptId).not.toBe(start.attemptId);
    const done = await simulatorComplete(order.publicId, retry.attemptId, "success");
    expect(done.status.paymentState).toBe("SUCCEEDED");
  });

  it("simulatorComplete success goes through the webhook path and stores a signed WebhookEvent", async () => {
    const shop = await makeShop();
    const { order, start } = await orderWithSimAttempt(shop);
    const r = await simulatorComplete(order.publicId, start.attemptId, "success");
    expect(r.outcome).toBe("PAID");
    expect(r.result.result).toBe("PROCESSED");
    const ev = await db.webhookEvent.findFirstOrThrow({ where: { provider: "DEV_SIMULATOR" } });
    expect(ev.signatureValid).toBe(true);
    expect(ev.status).toBe("PROCESSED");
  });

  it("stock is decremented only when payment is verified, never below zero", async () => {
    const shop = await makeShop();
    await db.product.update({ where: { id: shop.product.id }, data: { trackInventory: true, stockQty: 3 } });
    const { order } = await orderWithSimAttempt(shop, { items: [{ productId: shop.product.id, quantity: 2 }] });
    expect((await db.product.findUniqueOrThrow({ where: { id: shop.product.id } })).stockQty).toBe(3);
    const o = await db.order.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(o.status).toBe("PENDING_PAYMENT");
    const at = await db.paymentAttempt.findFirstOrThrow({ where: { orderId: order.orderId } });
    await simulatorComplete(order.publicId, at.id, "success");
    expect((await db.product.findUniqueOrThrow({ where: { id: shop.product.id } })).stockQty).toBe(1);
  });
});

describe("notifications only after a verified payment", () => {
  it("sends nothing while unpaid, failed, mismatched or cancelled", async () => {
    const shop = await makeShop();
    const { order, start } = await orderWithSimAttempt(shop);
    await deliver("DEV_SIMULATOR", simulatorWebhook({ providerOrderId: start.providerOrderId, providerPaymentId: "sim_pay_m", amountMinor: 1 }));
    await simulatorComplete(order.publicId, start.attemptId, "cancel");
    expect(await db.notification.count({ where: { type: { in: ["payment.receipt", "payment.received"] } } })).toBe(0);
  });

  it("creates the customer receipt and business notifications once, after the verified payment", async () => {
    const shop = await makeShop();
    const { order, start } = await orderWithSimAttempt(shop);
    expect(await db.notification.count({ where: { type: { in: ["payment.receipt", "payment.received"] } } })).toBe(0);
    await simulatorComplete(order.publicId, start.attemptId, "success");
    const receipt = await db.notification.findMany({ where: { type: "payment.receipt" } });
    expect(receipt.length).toBe(1);
    expect(receipt[0].toAddress).toBe("asha@example.com");
    expect(await db.notification.count({ where: { type: "payment.received" } })).toBeGreaterThanOrEqual(1);
    // Replays do not notify again.
    await deliver("DEV_SIMULATOR", simulatorWebhook({ providerOrderId: start.providerOrderId, providerPaymentId: `sim_pay_${start.attemptId}`, amountMinor: 10000 }));
    expect(await db.notification.count({ where: { type: "payment.receipt" } })).toBe(1);
  });

  it("a duplicate payment notifies admins for reconciliation and not the customer receipt again", async () => {
    await makeAdminSession();
    const shop = await makeShop();
    const { order, start } = await orderWithSimAttempt(shop);
    await simulatorComplete(order.publicId, start.attemptId, "success");
    await deliver("DEV_SIMULATOR", simulatorWebhook({ providerOrderId: start.providerOrderId, providerPaymentId: "sim_pay_dup2", amountMinor: 10000 }));
    expect(await db.notification.count({ where: { type: "payment.receipt" } })).toBe(1);
    expect(await db.notification.count({ where: { type: "payment.duplicate" } })).toBeGreaterThanOrEqual(1);
  });
});

describe("simulator is dev only", () => {
  it("is refused when NODE_ENV is production: options, start, complete, signing and ingestion", async () => {
    const shop = await makeShop();
    const { order, start } = await orderWithSimAttempt(shop);
    const w = simulatorWebhook({ providerOrderId: start.providerOrderId, providerPaymentId: "sim_pay_prod", amountMinor: 10000 });
    // The env guard itself refuses to boot in production with the simulator flag on.
    setEnv("NODE_ENV", "production");
    expect(() => env()).toThrow(/PAYMENT_SIMULATOR_ENABLED/);
    setEnv("PAYMENT_SIMULATOR_ENABLED", undefined);
    try {
      expect((await getPaymentOptions(order.publicId)).options.some((o) => o.provider === "DEV_SIMULATOR")).toBe(false);
      const o2 = await placeOrder(shop);
      expect(await code(() => startPayment(customerCtx(), { publicId: o2.publicId, provider: "DEV_SIMULATOR", method: "simulator", idempotencyKey: idemKey() }))).toBe("BAD_REQUEST");
      expect(await code(() => simulatorComplete(order.publicId, start.attemptId, "success"))).toBe("FORBIDDEN");
      expect(await code(() => deliver("DEV_SIMULATOR", w))).toBe("NOT_FOUND");
      expect(() => signSimulatorBody("x")).toThrow();
    } finally {
      setEnv("NODE_ENV", savedEnv.NODE_ENV);
    }
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("PENDING_PAYMENT");
    expect(await db.paymentTransaction.count()).toBe(0);
  });

  it("is also refused when PAYMENT_SIMULATOR_ENABLED is not true", async () => {
    const shop = await makeShop();
    const { order, start } = await orderWithSimAttempt(shop);
    setEnv("PAYMENT_SIMULATOR_ENABLED", "false");
    expect(await code(() => simulatorComplete(order.publicId, start.attemptId, "success"))).toBe("FORBIDDEN");
    const res = await simulateRoute(req("POST", `/api/pay/${order.publicId}/simulate`, { body: { attemptId: start.attemptId, outcome: "success" } }), seg({ publicId: order.publicId }));
    expect(res.status).toBe(403);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("PENDING_PAYMENT");
  });

  it("a simulator event signed with the wrong key is rejected", async () => {
    const shop = await makeShop();
    const { start } = await orderWithSimAttempt(shop);
    const w = simulatorWebhook({ providerOrderId: start.providerOrderId, providerPaymentId: "sim_pay_bad", amountMinor: 10000 });
    w.headers["x-simulator-signature"] = "0".repeat(64);
    const r = await deliver("DEV_SIMULATOR", w);
    expect(r.result).toBe("INVALID_SIGNATURE");
    expect(r.httpStatus).toBe(401);
    expect(await db.paymentTransaction.count()).toBe(0);
  });

  it("simulate route happy path returns the status view", async () => {
    const shop = await makeShop();
    const { order, start } = await orderWithSimAttempt(shop);
    const res = await simulateRoute(req("POST", `/api/pay/${order.publicId}/simulate`, { body: { attemptId: start.attemptId, outcome: "success" } }), seg({ publicId: order.publicId }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status.paymentState).toBe("SUCCEEDED");
  });
});

describe("order expiry cron", () => {
  it("returns 401 when CRON_SECRET is unset, missing or wrong; works with the right secret", async () => {
    const shop = await makeShop();
    const o = await placeOrder(shop);
    await db.order.update({ where: { id: o.orderId }, data: { expiresAt: new Date(Date.now() - 60_000) } });

    setEnv("CRON_SECRET", undefined);
    expect((await cronRoute(req("POST", "/api/cron/expire", { headers: { "x-cron-secret": "anything-anything-1234" } }), seg({}))).status).toBe(401);

    const secret = "cron-secret-value-0123456789";
    setEnv("CRON_SECRET", secret);
    expect((await cronRoute(req("POST", "/api/cron/expire"), seg({}))).status).toBe(401);
    expect((await cronRoute(req("POST", "/api/cron/expire", { headers: { "x-cron-secret": "wrong-wrong-wrong-wrong" } }), seg({}))).status).toBe(401);
    expect((await db.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe("PENDING_PAYMENT");

    const ok = await cronRoute(req("POST", "/api/cron/expire", { headers: { "x-cron-secret": secret } }), seg({}));
    expect(ok.status).toBe(200);
    expect((await ok.json()).data.expired).toBe(1);
    expect((await db.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe("EXPIRED");
    // Bearer form and repeat runs are safe.
    const again = await cronRoute(req("POST", "/api/cron/expire", { headers: { authorization: `Bearer ${secret}` } }), seg({}));
    expect((await again.json()).data.expired).toBe(0);
  });

  it("does not expire paid orders or orders that are still within their window", async () => {
    const shop = await makeShop();
    const { order } = await paidOrder(shop);
    await db.order.update({ where: { id: order.orderId }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    const fresh = await placeOrder(shop);
    const r = await expireStaleOrders();
    expect(r.expired).toBe(0);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("PAID");
    expect((await db.order.findUniqueOrThrow({ where: { id: fresh.orderId } })).status).toBe("PENDING_PAYMENT");
  });
});

describe("secrets never leave the server", () => {
  it("no public pay response or stored attempt/audit row contains provider secrets", async () => {
    mockProviderHttp();
    const shop = await makeShop();
    const { configId } = await activateConfig(shop);
    const { order, start } = await orderWithRazorpayAttempt(shop, configId);
    const sig = hmacSha256Hex(RZP_SECRET, `${start.providerOrderId}|pay_s1`);
    const vr = await verifyRoute(req("POST", `/api/pay/${order.publicId}/verify`, { body: { providerOrderId: start.providerOrderId, providerPaymentId: "pay_s1", signature: sig } }), seg({ publicId: order.publicId }));
    const texts = [await vr.text(), JSON.stringify(start), JSON.stringify(await getPaymentOptions(order.publicId)), JSON.stringify(await getPaymentStatus(order.publicId))];
    for (const t of texts) {
      expect(t).not.toContain(RZP_SECRET);
      expect(t).not.toContain(RZP_WEBHOOK_SECRET);
    }
    const audits = JSON.stringify(await db.auditLog.findMany());
    expect(audits).not.toContain(RZP_SECRET);
    expect(audits).not.toContain(RZP_WEBHOOK_SECRET);
    const cfg = await db.paymentProviderConfig.findUniqueOrThrow({ where: { id: configId } });
    expect(cfg.secretEnc).not.toContain(RZP_SECRET);
    expect(cfg.webhookSecretEnc ?? "").not.toContain(RZP_WEBHOOK_SECRET);
  });
});
