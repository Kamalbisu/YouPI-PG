import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { requestRefund, listRefunds } from "@/server/services/refunds";
import { GET as adminRefundsGet, POST as adminRefundsPost } from "@/app/api/admin/refunds/route";
import { POST as clientRefundsPost, GET as clientRefundsGet } from "@/app/api/client/refunds/route";
import { resetDb } from "./helpers";
import {
  activateConfig,
  code,
  customerCtx,
  deliver,
  idemKey,
  makeAdminSession,
  makeShop,
  mockProviderHttp,
  orderWithRazorpayAttempt,
  paidOrder,
  razorpayPaymentWebhook,
  razorpayRefundWebhook,
  req,
  simulatorWebhook,
  stopProviderHttp,
  ctxFromUser,
  type Shop,
} from "./helpers-payments";

beforeEach(async () => {
  await resetDb();
  mockProviderHttp();
});
afterEach(() => stopProviderHttp());

const refundInput = (transactionId: string, amountMinor: number, over: Record<string, unknown> = {}) => ({
  transactionId,
  amountMinor,
  reason: "Customer returned the item",
  idempotencyKey: idemKey("rf"),
  ...over,
});

async function razorpayPaid(shop: Shop, configId: string, paymentId: string) {
  const { order, start } = await orderWithRazorpayAttempt(shop, configId);
  await deliver("RAZORPAY", razorpayPaymentWebhook({ providerOrderId: start.providerOrderId!, paymentId, amountMinor: order.totalMinor }), { configId });
  const txn = await db.paymentTransaction.findFirstOrThrow({ where: { orderId: order.orderId } });
  return { order, start, txn };
}

describe("requestRefund basics", () => {
  it("owner refunds part of a simulator payment: totals, statuses, audit and notification", async () => {
    const shop = await makeShop();
    const { order, txn } = await paidOrder(shop);
    const r = await requestRefund(shop.ctx, refundInput(txn.id, 3000));
    expect(r.status).toBe("PROCESSED");
    expect(r.amountMinor).toBe(3000);
    expect(r.refundRef).toMatch(/^RFD-/);
    const t = await db.paymentTransaction.findUniqueOrThrow({ where: { id: txn.id } });
    expect(t.refundedMinor).toBe(3000);
    expect(t.status).toBe("PARTIALLY_REFUNDED");
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("PARTIALLY_REFUNDED");

    const r2 = await requestRefund(shop.ctx, refundInput(txn.id, order.totalMinor - 3000));
    expect(r2.status).toBe("PROCESSED");
    const t2 = await db.paymentTransaction.findUniqueOrThrow({ where: { id: txn.id } });
    expect(t2.status).toBe("REFUNDED");
    expect(t2.refundedMinor).toBe(order.totalMinor);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("REFUNDED");

    expect(await db.auditLog.count({ where: { action: "refund.request" } })).toBe(2);
    expect(await db.auditLog.count({ where: { action: "refund.processed" } })).toBe(2);
    const mails = await db.notification.findMany({ where: { type: "refund.processed" } });
    expect(mails.length).toBeGreaterThanOrEqual(2);
  });

  it("refuses more than the paid amount, a fully refunded transaction and non-positive amounts", async () => {
    const shop = await makeShop();
    const { order, txn } = await paidOrder(shop);
    expect(await code(() => requestRefund(shop.ctx, refundInput(txn.id, order.totalMinor + 1)))).toBe("BAD_REQUEST");
    expect(await code(() => requestRefund(shop.ctx, refundInput(txn.id, 0)))).toBe("VALIDATION");
    expect(await code(() => requestRefund(shop.ctx, refundInput(txn.id, -5)))).toBe("VALIDATION");
    expect(await code(() => requestRefund(shop.ctx, refundInput(txn.id, 10.5)))).toBe("VALIDATION");
    expect(await code(() => requestRefund(shop.ctx, refundInput(txn.id, 100, { reason: "" })))).toBe("VALIDATION");
    expect(await code(() => requestRefund(shop.ctx, refundInput(txn.id, 100, { idempotencyKey: "short" })))).toBe("VALIDATION");
    expect(await db.refund.count()).toBe(0);
    await requestRefund(shop.ctx, refundInput(txn.id, order.totalMinor));
    expect(await code(() => requestRefund(shop.ctx, refundInput(txn.id, 1)))).toBe("CONFLICT");
    expect((await db.paymentTransaction.findUniqueOrThrow({ where: { id: txn.id } })).refundedMinor).toBe(order.totalMinor);
  });

  it("idempotent: same key returns the same refund once; same key with another amount conflicts", async () => {
    const shop = await makeShop();
    const { txn } = await paidOrder(shop);
    const input = refundInput(txn.id, 2000);
    const a = await requestRefund(shop.ctx, input);
    const b = await requestRefund(shop.ctx, input);
    expect(b.id).toBe(a.id);
    expect(b.replayed).toBe(true);
    expect(await db.refund.count()).toBe(1);
    expect((await db.paymentTransaction.findUniqueOrThrow({ where: { id: txn.id } })).refundedMinor).toBe(2000);
    expect(await code(() => requestRefund(shop.ctx, { ...input, amountMinor: 2500 }))).toBe("CONFLICT");
    expect(await db.refund.count()).toBe(1);
  });

  it("concurrent refunds cannot over-refund (race with the row lock)", async () => {
    const shop = await makeShop({ priceMinor: 10000 });
    const { order, txn } = await paidOrder(shop);
    expect(order.totalMinor).toBe(10000);
    // 8 concurrent requests of 3000 against 10000: at most 3 can win.
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => requestRefund(shop.ctx, refundInput(txn.id, 3000))));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBe(3);
    const t = await db.paymentTransaction.findUniqueOrThrow({ where: { id: txn.id } });
    expect(t.refundedMinor).toBe(9000);
    expect(t.refundedMinor).toBeLessThanOrEqual(t.amountMinor);
    const sum = await db.refund.aggregate({ where: { transactionId: txn.id, status: { in: ["PENDING", "PROCESSED"] } }, _sum: { amountMinor: true } });
    expect(sum._sum.amountMinor).toBe(9000);
    for (const r of results.filter((x) => x.status === "rejected")) expect((r as PromiseRejectedResult).reason.code).toBe("BAD_REQUEST");
  });

  it("concurrent identical requests with one key create one refund", async () => {
    const shop = await makeShop();
    const { txn } = await paidOrder(shop);
    const input = refundInput(txn.id, 1500);
    const rs = await Promise.all(Array.from({ length: 5 }, () => requestRefund(shop.ctx, input)));
    expect(new Set(rs.map((r) => r.id)).size).toBe(1);
    expect(await db.refund.count()).toBe(1);
    expect((await db.paymentTransaction.findUniqueOrThrow({ where: { id: txn.id } })).refundedMinor).toBe(1500);
  });
});

describe("refund authorisation and tenancy", () => {
  it("manager is forbidden, unauthenticated is rejected, missing permission is forbidden", async () => {
    const shop = await makeShop();
    const { txn } = await paidOrder(shop);
    expect(await code(() => requestRefund(shop.managerCtx, refundInput(txn.id, 100)))).toBe("FORBIDDEN");
    expect(await code(() => requestRefund(customerCtx(), refundInput(txn.id, 100)))).toBe("UNAUTHENTICATED");
    const limited = { ...shop.ctx, actor: { ...shop.ctx.actor!, permissions: ["payments.view"] } };
    expect(await code(() => requestRefund(limited, refundInput(txn.id, 100)))).toBe("FORBIDDEN");
    expect(await db.refund.count()).toBe(0);
  });

  it("another tenant's owner gets NOT_FOUND, an unknown id is NOT_FOUND, and nothing changes", async () => {
    const a = await makeShop({ tag: "a" });
    const b = await makeShop({ tag: "b" });
    const { txn } = await paidOrder(a);
    expect(await code(() => requestRefund(b.ctx, refundInput(txn.id, 100)))).toBe("NOT_FOUND");
    expect(await code(() => requestRefund(b.ctx, refundInput("missing-txn", 100)))).toBe("NOT_FOUND");
    expect(await db.refund.count()).toBe(0);
    expect((await db.paymentTransaction.findUniqueOrThrow({ where: { id: txn.id } })).refundedMinor).toBe(0);
  });

  it("the same idempotency key used by another tenant never reveals or reuses the refund", async () => {
    const a = await makeShop({ tag: "a" });
    const b = await makeShop({ tag: "b" });
    const pa = await paidOrder(a);
    const pb = await paidOrder(b);
    const key = idemKey("shared");
    const ra = await requestRefund(a.ctx, refundInput(pa.txn.id, 1000, { idempotencyKey: key }));
    const rb = await requestRefund(b.ctx, refundInput(pb.txn.id, 1000, { idempotencyKey: key }));
    expect(rb.id).not.toBe(ra.id);
    expect(rb.replayed).toBeUndefined();
  });

  it("admin can refund any tenant's transaction", async () => {
    const shop = await makeShop();
    const admin = await makeAdminSession();
    const { txn } = await paidOrder(shop);
    const r = await requestRefund(admin.ctx, refundInput(txn.id, 500));
    expect(r.status).toBe("PROCESSED");
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "refund.request" } });
    expect(log.clientId).toBe(shop.client.id);
  });

  it("routes: manager 403, other tenant 404, owner 200 with { data }, admin route rejects clients", async () => {
    const a = await makeShop({ tag: "a" });
    const b = await makeShop({ tag: "b" });
    const { txn } = await paidOrder(a);
    const post = (cookie: string, amountMinor = 1000) => clientRefundsPost(req("POST", "/api/client/refunds", { cookie, body: refundInput(txn.id, amountMinor) }), { params: Promise.resolve({}) } as never);
    expect((await post(a.managerCookie)).status).toBe(403);
    const other = await post(b.cookie);
    expect(other.status).toBe(404);
    expect((await other.json()).error.code).toBe("NOT_FOUND");
    expect((await post("")).status).toBe(401);
    const ok = await post(a.cookie);
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.data.status).toBe("PROCESSED");
    expect(body.data.amountMinor).toBe(1000);
    const adminRoute = await adminRefundsPost(req("POST", "/api/admin/refunds", { cookie: a.cookie, body: refundInput(txn.id, 100) }), { params: Promise.resolve({}) } as never);
    expect(adminRoute.status).toBe(403);
    const bad = await post(a.cookie, 0);
    expect(bad.status).toBe(422);
  });
});

describe("refund listing", () => {
  it("is tenant scoped for clients, complete for admins, filters by status", async () => {
    const a = await makeShop({ tag: "a" });
    const b = await makeShop({ tag: "b" });
    const admin = await makeAdminSession();
    const pa = await paidOrder(a);
    const pb = await paidOrder(b);
    await requestRefund(a.ctx, refundInput(pa.txn.id, 1000));
    await requestRefund(b.ctx, refundInput(pb.txn.id, 1000));
    const forA = await listRefunds(a.ctx, {});
    expect(forA.items).toHaveLength(1);
    expect(forA.items[0].transactionId).toBe(pa.txn.id);
    expect((await listRefunds(admin.ctx, {})).items).toHaveLength(2);
    expect((await listRefunds(admin.ctx, { status: "FAILED" })).items).toHaveLength(0);
    expect(await code(() => listRefunds(a.managerCtx, { status: "BOGUS" }))).toBe("VALIDATION");
    const res = await clientRefundsGet(req("GET", "/api/client/refunds", { cookie: a.cookie }), { params: Promise.resolve({}) } as never);
    expect((await res.json()).data.items).toHaveLength(1);
    const adminRes = await adminRefundsGet(req("GET", "/api/admin/refunds", { cookie: admin.cookie }), { params: Promise.resolve({}) } as never);
    expect((await adminRes.json()).data.items).toHaveLength(2);
    const denied = await adminRefundsGet(req("GET", "/api/admin/refunds", { cookie: a.cookie }), { params: Promise.resolve({}) } as never);
    expect(denied.status).toBe(403);
  });
});

describe("provider refunds (Razorpay, mocked HTTP)", () => {
  it("sends the refund to the provider with the paid amount reference; a provider failure marks it FAILED and frees the amount", async () => {
    const calls = mockProviderHttp((c) => (c.url.includes("/refund") ? [500, { error: { description: "gateway down" } }] : undefined));
    const shop = await makeShop();
    const { configId } = await activateConfig(shop);
    const { txn } = await razorpayPaid(shop, configId, "pay_ref1");
    const err = await code(() => requestRefund(shop.ctx, refundInput(txn.id, 4000)));
    expect(["PROVIDER_UNAVAILABLE", "PAYMENT_ERROR"]).toContain(err);
    expect(calls.some((c) => c.url.includes("/payments/pay_ref1/refund"))).toBe(true);
    const failed = await db.refund.findFirstOrThrow({ where: { transactionId: txn.id } });
    expect(failed.status).toBe("FAILED");
    expect((await db.paymentTransaction.findUniqueOrThrow({ where: { id: txn.id } })).refundedMinor).toBe(0);
    expect(await db.auditLog.count({ where: { action: "refund.failed" } })).toBe(1);
    // The amount is available again.
    mockProviderHttp();
    const ok = await requestRefund(shop.ctx, refundInput(txn.id, txn.amountMinor));
    expect(ok.status).toBe("PROCESSED");
  });

  it("a refund the provider leaves pending reserves the amount until the webhook settles it; replays do not double count", async () => {
    mockProviderHttp((c) => (c.url.includes("/refund") ? [200, { id: "rfnd_pending1", status: "pending", amount: (c.body as { amount: number }).amount }] : undefined));
    const shop = await makeShop({ priceMinor: 10000 });
    const { configId } = await activateConfig(shop);
    const { txn } = await razorpayPaid(shop, configId, "pay_ref2");
    const r = await requestRefund(shop.ctx, refundInput(txn.id, 6000));
    expect(r.status).toBe("PENDING");
    expect((await db.paymentTransaction.findUniqueOrThrow({ where: { id: txn.id } })).refundedMinor).toBe(0);
    // The pending amount counts against what is refundable.
    expect(await code(() => requestRefund(shop.ctx, refundInput(txn.id, 5000)))).toBe("BAD_REQUEST");

    const wh = razorpayRefundWebhook({ paymentId: "pay_ref2", refundId: "rfnd_pending1", amountMinor: 6000, refundRef: r.refundRef });
    const first = await deliver("RAZORPAY", wh, { configId });
    expect(first.result).toBe("PROCESSED");
    const t = await db.paymentTransaction.findUniqueOrThrow({ where: { id: txn.id } });
    expect(t.refundedMinor).toBe(6000);
    expect(t.status).toBe("PARTIALLY_REFUNDED");
    expect((await deliver("RAZORPAY", wh, { configId })).result).toBe("DUPLICATE");
    expect((await db.paymentTransaction.findUniqueOrThrow({ where: { id: txn.id } })).refundedMinor).toBe(6000);
    expect((await db.refund.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("PROCESSED");
  });

  it("a refund.failed webhook fails a pending refund and never downgrades a processed one", async () => {
    mockProviderHttp((c) => (c.url.includes("/refund") ? [200, { id: "rfnd_pf", status: "pending", amount: (c.body as { amount: number }).amount }] : undefined));
    const shop = await makeShop({ priceMinor: 10000 });
    const { configId } = await activateConfig(shop);
    const { txn } = await razorpayPaid(shop, configId, "pay_ref3");
    const r = await requestRefund(shop.ctx, refundInput(txn.id, 2000));
    await deliver("RAZORPAY", razorpayRefundWebhook({ paymentId: "pay_ref3", refundId: "rfnd_pf", amountMinor: 2000, refundRef: r.refundRef, event: "refund.failed" }), { configId });
    expect((await db.refund.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("FAILED");
    expect((await db.paymentTransaction.findUniqueOrThrow({ where: { id: txn.id } })).refundedMinor).toBe(0);

    // A processed refund stays processed even if a late failed event arrives.
    mockProviderHttp();
    const ok = await requestRefund(shop.ctx, refundInput(txn.id, 2000));
    expect(ok.status).toBe("PROCESSED");
    await deliver("RAZORPAY", razorpayRefundWebhook({ paymentId: "pay_ref3", refundId: "rfnd_other", amountMinor: 2000, refundRef: ok.refundRef, event: "refund.failed" }), { configId });
    expect((await db.refund.findUniqueOrThrow({ where: { id: ok.id } })).status).toBe("PROCESSED");
    expect((await db.paymentTransaction.findUniqueOrThrow({ where: { id: txn.id } })).refundedMinor).toBe(2000);
  });

  it("a refund created in the provider dashboard is recorded; one larger than what remains is not", async () => {
    const shop = await makeShop({ priceMinor: 10000 });
    const { configId } = await activateConfig(shop);
    const { txn } = await razorpayPaid(shop, configId, "pay_ref4");
    const ext = await deliver("RAZORPAY", razorpayRefundWebhook({ paymentId: "pay_ref4", refundId: "rfnd_ext1", amountMinor: 2500 }), { configId });
    expect(ext.result).toBe("PROCESSED");
    expect((await db.paymentTransaction.findUniqueOrThrow({ where: { id: txn.id } })).refundedMinor).toBe(2500);
    const tooBig = await deliver("RAZORPAY", razorpayRefundWebhook({ paymentId: "pay_ref4", refundId: "rfnd_ext2", amountMinor: 9000 }), { configId });
    expect(tooBig.result).toBe("IGNORED");
    expect((await db.paymentTransaction.findUniqueOrThrow({ where: { id: txn.id } })).refundedMinor).toBe(2500);
  });

  it("a refund webhook delivered through another business's endpoint changes nothing", async () => {
    const a = await makeShop({ tag: "a" });
    const b = await makeShop({ tag: "b" });
    const cfgA = await activateConfig(a);
    const cfgB = await activateConfig(b);
    const { txn } = await razorpayPaid(a, cfgA.configId, "pay_ref5");
    const r = await deliver("RAZORPAY", razorpayRefundWebhook({ paymentId: "pay_ref5", refundId: "rfnd_x", amountMinor: 1000 }), { configId: cfgB.configId });
    expect(r.result).toBe("IGNORED");
    expect((await db.paymentTransaction.findUniqueOrThrow({ where: { id: txn.id } })).refundedMinor).toBe(0);
    expect(await db.refund.count()).toBe(0);
  });
});

describe("simulator refund events and duplicate payments", () => {
  it("a signed simulator refund.processed event for a pending refund settles it", async () => {
    const shop = await makeShop();
    const { txn } = await paidOrder(shop);
    const r = await requestRefund(shop.ctx, refundInput(txn.id, 1000));
    expect(r.status).toBe("PROCESSED");
    const ev = simulatorWebhook({ type: "refund.processed", providerPaymentId: txn.providerPaymentId, providerRefundId: "sim_refund_ext", amountMinor: 1000, refundRef: r.refundRef });
    await deliver("DEV_SIMULATOR", ev);
    expect((await db.paymentTransaction.findUniqueOrThrow({ where: { id: txn.id } })).refundedMinor).toBe(1000);
  });

  it("refunding a flagged duplicate payment leaves the order's own status alone", async () => {
    const shop = await makeShop();
    const { order, start, txn } = await paidOrder(shop);
    const second = await deliver("DEV_SIMULATOR", simulatorWebhook({ providerOrderId: start.providerOrderId!, providerPaymentId: "sim_pay_second", amountMinor: order.totalMinor }));
    expect(second.outcome).toBe("DUPLICATE");
    const dup = await db.paymentTransaction.findFirstOrThrow({ where: { providerPaymentId: "sim_pay_second" } });
    expect(dup.isDuplicate).toBe(true);
    const r = await requestRefund(shop.ctx, refundInput(dup.id, dup.amountMinor));
    expect(r.status).toBe("PROCESSED");
    expect((await db.paymentTransaction.findUniqueOrThrow({ where: { id: dup.id } })).status).toBe("REFUNDED");
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("PAID");
    expect((await db.paymentTransaction.findUniqueOrThrow({ where: { id: txn.id } })).refundedMinor).toBe(0);
  });

  it("audit metadata of refunds holds no secrets", async () => {
    const shop = await makeShop();
    const { txn } = await paidOrder(shop);
    await requestRefund(shop.ctx, refundInput(txn.id, 700));
    const logs = await db.auditLog.findMany({ where: { action: { startsWith: "refund." } } });
    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(logs)).not.toMatch(/secret|signature|rzp_/i);
    void ctxFromUser;
    void NextRequest;
  });
});
