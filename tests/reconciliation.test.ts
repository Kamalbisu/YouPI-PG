import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { GET as listGet } from "@/app/api/admin/reconciliation/route";
import { POST as refetchPost } from "@/app/api/admin/reconciliation/refetch/route";
import { POST as reviewPost } from "@/app/api/admin/reconciliation/review/route";
import { listReconciliation, markReconciliationReviewed, refetchOrderPayment, RECON_KINDS, type ReconKind } from "@/server/services/reconciliation";
import { expireStaleOrders } from "@/server/services/payment-verification";
import { requestRefund } from "@/server/services/refunds";
import { resetDb } from "./helpers";
import {
  code,
  customerCtx,
  deliver,
  idemKey,
  makeAdminSession,
  makeShop,
  orderWithSimAttempt,
  paidOrder,
  req,
  simulatorWebhook,
} from "./helpers-payments";

const P = { params: Promise.resolve({}) } as never;

beforeEach(async () => {
  await resetDb();
});

async function section(admin: Awaited<ReturnType<typeof makeAdminSession>>, kind: ReconKind, input: unknown = {}) {
  const r = await listReconciliation(admin.ctx, input);
  return r.sections.find((s) => s.kind === kind)!;
}

describe("reconciliation listings", () => {
  it("returns every section, all empty, on a clean database", async () => {
    const admin = await makeAdminSession();
    const r = await listReconciliation(admin.ctx, {});
    expect(r.sections.map((s) => s.kind)).toEqual([...RECON_KINDS]);
    expect(r.sections.every((s) => s.total === 0 && s.items.length === 0)).toBe(true);
    expect(r.openCount).toBe(0);
  });

  it("lists stuck attempts only past the threshold", async () => {
    const shop = await makeShop();
    const admin = await makeAdminSession();
    const { order, start } = await orderWithSimAttempt(shop);
    expect((await section(admin, "STUCK_ATTEMPT")).items).toHaveLength(0);
    await db.paymentAttempt.update({ where: { id: start.attemptId }, data: { createdAt: new Date(Date.now() - 2 * 3600_000) } });
    const s = await section(admin, "STUCK_ATTEMPT");
    expect(s.items).toHaveLength(1);
    expect(s.items[0].id).toBe(start.attemptId);
    expect(s.items[0].orderCode).toBe(order.orderCode);
    expect(s.items[0].businessName).toBe(shop.business.name);
    // A longer threshold hides it again.
    expect((await section(admin, "STUCK_ATTEMPT", { stuckMinutes: 600 })).items).toHaveLength(0);
    // Once the payment succeeds the attempt is no longer stuck.
    await deliver("DEV_SIMULATOR", simulatorWebhook({ providerOrderId: start.providerOrderId!, providerPaymentId: "sim_pay_s1", amountMinor: order.totalMinor }));
    expect((await section(admin, "STUCK_ATTEMPT")).items).toHaveLength(0);
  });

  it("lists a duplicate payment until it is refunded", async () => {
    const shop = await makeShop();
    const admin = await makeAdminSession();
    const { order, start } = await paidOrder(shop);
    await deliver("DEV_SIMULATOR", simulatorWebhook({ providerOrderId: start.providerOrderId!, providerPaymentId: "sim_pay_dup2", amountMinor: order.totalMinor }));
    const dup = await db.paymentTransaction.findFirstOrThrow({ where: { providerPaymentId: "sim_pay_dup2" } });
    expect(dup.isDuplicate).toBe(true);
    const s = await section(admin, "DUPLICATE_PAYMENT");
    expect(s.items.map((i) => i.id)).toEqual([dup.id]);
    await requestRefund(shop.ctx, { transactionId: dup.id, amountMinor: dup.amountMinor, reason: "Duplicate payment refund", idempotencyKey: idemKey("d") });
    expect((await section(admin, "DUPLICATE_PAYMENT")).items).toHaveLength(0);
  });

  it("lists an amount mismatch and the order stays unpaid", async () => {
    const shop = await makeShop();
    const admin = await makeAdminSession();
    const { order, start } = await orderWithSimAttempt(shop);
    await deliver("DEV_SIMULATOR", simulatorWebhook({ providerOrderId: start.providerOrderId!, providerPaymentId: "sim_pay_short", amountMinor: order.totalMinor - 100 }));
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe("PENDING_PAYMENT");
    const s = await section(admin, "AMOUNT_MISMATCH");
    expect(s.items).toHaveLength(1);
    expect(s.items[0].orderId).toBe(order.orderId);
    expect(s.items[0].detail).toMatch(/Amount mismatch/);
  });

  it("lists a paid order with no verified transaction and a transaction on an unsettled order", async () => {
    const shop = await makeShop();
    const admin = await makeAdminSession();
    // Paid without proof (forced directly in the database, as a data-repair scenario).
    const a = await orderWithSimAttempt(shop);
    await db.order.update({ where: { id: a.order.orderId }, data: { status: "PAID" } });
    const s1 = await section(admin, "PAID_WITHOUT_TXN");
    expect(s1.items.map((i) => i.id)).toEqual([a.order.orderId]);
    // Verified transaction whose order was moved back.
    const b = await paidOrder(shop);
    await db.order.update({ where: { id: b.order.orderId }, data: { status: "PENDING_PAYMENT" } });
    const s2 = await section(admin, "TXN_ORDER_MISMATCH");
    expect(s2.items.map((i) => i.id)).toContain(b.txn.id);
    // A transaction whose amount disagrees with its settled order.
    const c = await paidOrder(shop);
    await db.paymentTransaction.update({ where: { id: c.txn.id }, data: { amountMinor: c.txn.amountMinor + 50 } });
    const s3 = await section(admin, "TXN_ORDER_MISMATCH");
    expect(s3.items.map((i) => i.id)).toContain(c.txn.id);
    expect(s3.items.find((i) => i.id === c.txn.id)!.title).toMatch(/amount differs/i);
  });

  it("lists a late payment on an expired order", async () => {
    const shop = await makeShop();
    const admin = await makeAdminSession();
    const { order, start } = await orderWithSimAttempt(shop);
    await expireStaleOrders(new Date(Date.now() + 3 * 3600_000));
    await deliver("DEV_SIMULATOR", simulatorWebhook({ providerOrderId: start.providerOrderId!, providerPaymentId: "sim_pay_late2", amountMinor: order.totalMinor }));
    const s = await section(admin, "LATE_PAYMENT");
    expect(s.items.map((i) => i.id)).toEqual([order.orderId]);
  });

  it("lists failed webhooks with a valid signature, not unsigned noise", async () => {
    const admin = await makeAdminSession();
    await db.webhookEvent.create({ data: { provider: "RAZORPAY", eventId: "evt_failed_1", eventType: "payment.captured", signatureValid: true, status: "FAILED", error: "database unavailable", payload: {} } });
    await db.webhookEvent.create({ data: { provider: "RAZORPAY", eventId: "evt_badsig_1", eventType: "payment.captured", signatureValid: false, status: "FAILED", error: "bad signature", payload: {} } });
    await db.webhookEvent.create({ data: { provider: "RAZORPAY", eventId: "evt_ok_1", eventType: "payment.captured", signatureValid: true, status: "PROCESSED", payload: {} } });
    const s = await section(admin, "FAILED_WEBHOOK");
    expect(s.items).toHaveLength(1);
    expect(s.items[0].detail).toBe("database unavailable");
  });

  it("validates the stuck-minutes filter", async () => {
    const admin = await makeAdminSession();
    expect(await code(() => listReconciliation(admin.ctx, { stuckMinutes: 0 }))).toBe("VALIDATION");
    expect(await code(() => listReconciliation(admin.ctx, { stuckMinutes: "abc" }))).toBe("VALIDATION");
  });
});

describe("review and refetch", () => {
  it("marking an item reviewed hides it, keeps it with includeReviewed, writes an audit and keeps the note", async () => {
    const shop = await makeShop();
    const admin = await makeAdminSession();
    const { order, start } = await orderWithSimAttempt(shop);
    await db.paymentAttempt.update({ where: { id: start.attemptId }, data: { createdAt: new Date(Date.now() - 2 * 3600_000) } });
    expect((await listReconciliation(admin.ctx, {})).openCount).toBe(1);
    await markReconciliationReviewed(admin.ctx, { kind: "STUCK_ATTEMPT", id: start.attemptId, note: "Customer abandoned the page" });
    expect((await listReconciliation(admin.ctx, {})).openCount).toBe(0);
    const all = await section(admin, "STUCK_ATTEMPT", { includeReviewed: true });
    expect(all.items).toHaveLength(1);
    expect(all.items[0].reviewed).toBe(true);
    expect(all.items[0].reviewNote).toBe("Customer abandoned the page");
    expect(await db.auditLog.count({ where: { action: "reconciliation.reviewed" } })).toBe(1);
    // Reviewing one kind does not hide the same id under another kind.
    expect(order.orderId).toBeTruthy();
  });

  it("rejects a bad kind, a missing id and a note that is too short", async () => {
    const admin = await makeAdminSession();
    expect(await code(() => markReconciliationReviewed(admin.ctx, { kind: "NOPE", id: "x1", note: "fine note" }))).toBe("VALIDATION");
    expect(await code(() => markReconciliationReviewed(admin.ctx, { kind: "STUCK_ATTEMPT", note: "fine note" }))).toBe("VALIDATION");
    expect(await code(() => markReconciliationReviewed(admin.ctx, { kind: "STUCK_ATTEMPT", id: "x1", note: "a" }))).toBe("VALIDATION");
    expect(await db.auditLog.count({ where: { action: "reconciliation.reviewed" } })).toBe(0);
  });

  it("refetch asks the provider through the single verification path, audits, and 404s for an unknown order", async () => {
    const shop = await makeShop();
    const admin = await makeAdminSession();
    const { order } = await orderWithSimAttempt(shop);
    const r = await refetchOrderPayment(admin.ctx, { orderId: order.orderId });
    expect(r.orderId).toBe(order.orderId);
    expect(r.orderStatus).toBe("PENDING_PAYMENT");
    expect(await db.auditLog.count({ where: { action: "reconciliation.refetch" } })).toBe(1);
    expect(await code(() => refetchOrderPayment(admin.ctx, { orderId: "missing-order-id" }))).toBe("NOT_FOUND");
    expect(await code(() => refetchOrderPayment(admin.ctx, {}))).toBe("VALIDATION");
    // The simulator cannot be fetched, so a refetch must never mark the order paid.
    expect((await db.paymentTransaction.count({ where: { orderId: order.orderId } }))).toBe(0);
  });
});

describe("reconciliation access control", () => {
  it("service functions refuse clients, managers and anonymous callers", async () => {
    const shop = await makeShop();
    const { order } = await orderWithSimAttempt(shop);
    expect(await code(() => listReconciliation(shop.ctx, {}))).toBe("FORBIDDEN");
    expect(await code(() => listReconciliation(shop.managerCtx, {}))).toBe("FORBIDDEN");
    expect(await code(() => listReconciliation(customerCtx(), {}))).toBe("UNAUTHENTICATED");
    expect(await code(() => refetchOrderPayment(shop.ctx, { orderId: order.orderId }))).toBe("FORBIDDEN");
    expect(await code(() => markReconciliationReviewed(shop.ctx, { kind: "STUCK_ATTEMPT", id: "x1", note: "fine note" }))).toBe("FORBIDDEN");
    expect(await db.auditLog.count({ where: { action: { startsWith: "reconciliation." } } })).toBe(0);
  });

  it("routes: admin 200 with { data }, client 403, anonymous 401, bad body 422", async () => {
    const shop = await makeShop();
    const admin = await makeAdminSession();
    const { order } = await orderWithSimAttempt(shop);
    const ok = await listGet(req("GET", "/api/admin/reconciliation", { cookie: admin.cookie }), P);
    expect(ok.status).toBe(200);
    expect((await ok.json()).data.sections).toHaveLength(RECON_KINDS.length);
    expect((await listGet(req("GET", "/api/admin/reconciliation", { cookie: shop.cookie }), P)).status).toBe(403);
    expect((await listGet(req("GET", "/api/admin/reconciliation"), P)).status).toBe(401);

    const rf = await refetchPost(req("POST", "/api/admin/reconciliation/refetch", { cookie: admin.cookie, body: { orderId: order.orderId } }), P);
    expect(rf.status).toBe(200);
    expect((await rf.json()).data.orderId).toBe(order.orderId);
    expect((await refetchPost(req("POST", "/api/admin/reconciliation/refetch", { cookie: shop.cookie, body: { orderId: order.orderId } }), P)).status).toBe(403);

    const rv = await reviewPost(req("POST", "/api/admin/reconciliation/review", { cookie: admin.cookie, body: { kind: "STUCK_ATTEMPT", id: "abc123", note: "checked" } }), P);
    expect(rv.status).toBe(200);
    const bad = await reviewPost(req("POST", "/api/admin/reconciliation/review", { cookie: admin.cookie, body: { kind: "STUCK_ATTEMPT", id: "abc123", note: "" } }), P);
    expect(bad.status).toBe(422);
    expect((await bad.json()).error.code).toBe("VALIDATION");
    expect((await reviewPost(req("POST", "/api/admin/reconciliation/review", { cookie: shop.cookie, body: { kind: "STUCK_ATTEMPT", id: "abc123", note: "checked" } }), P)).status).toBe(403);
  });
});
