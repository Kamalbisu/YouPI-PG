import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { newTxnId, reconcilePayment, reconcilePending, startPayment } from "@/server/services/payments";
import * as callback from "@/app/api/payments/callback/route";
import { PASSWORD, anonCtx, cookieFor, ctxFor, makeAdmin, makeUser, req, resetDb, seg } from "./helpers";
import { clearGateway, configureGateway, formReq, gatewayPayload, mockFetch } from "./gateway-helpers";

type Handler = (r: NextRequest, s: { params: Promise<Record<string, string>> }) => Promise<Response>;
void PASSWORD;

let userId: string;
let userCtx: Awaited<ReturnType<typeof ctxFor>>;
let adminCtx: Awaited<ReturnType<typeof ctxFor>>;

beforeEach(async () => {
  await resetDb();
  configureGateway();
  const u = await makeUser("asha", "+919876543210");
  userId = u.id;
  userCtx = await ctxFor(u);
  adminCtx = await ctxFor(await makeAdmin());
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearGateway();
});

async function pendingPayment(amount = "250") {
  mockFetch([{ status: 1, data: "AK1" }]);
  const r = await startPayment(userCtx, { amount, purpose: "School fees" });
  return r;
}

const postCallback = (fields: Record<string, string>) => (callback.POST as Handler)(formReq("/api/payments/callback", fields), seg());
const events = (type: string) => db.activityEvent.findMany({ where: { type }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });

describe("txn ids", () => {
  it("are random, well formed and unique", () => {
    const ids = new Set(Array.from({ length: 500 }, newTxnId));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(/^YP[0-9A-F]{20}$/);
  });
});

describe("startPayment", () => {
  it("creates a PENDING payment, signs the request and returns the checkout link", async () => {
    const calls = mockFetch([{ status: 1, data: "AK1" }]);
    const r = await startPayment(userCtx, { amount: "250.50", purpose: "School fees" });
    expect(r.checkoutUrl).toBe("https://testpay.easebuzz.in/pay/AK1");
    const p = await db.payment.findUniqueOrThrow({ where: { id: r.paymentId } });
    expect(p).toMatchObject({ status: "PENDING", amountPaise: 25050, userId, method: "EASEBUZZ", gatewayMode: "test" });
    expect(p.txnId).toBe(r.txnId);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.get("amount")).toBe("250.50");
    expect(calls[0]!.body.get("phone")).toBe("9876543210");
    expect(calls[0]!.body.get("surl")).toMatch(/\/api\/payments\/callback$/);
    expect(calls[0]!.body.get("salt")).toBeNull();
    const types = (await db.activityEvent.findMany({ where: { paymentId: p.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })).map((e) => e.type);
    expect(types).toEqual(["payment.initiated", "payment.redirected"]);
  });

  it("asks for a real phone number instead of inventing one", async () => {
    const calls = mockFetch([{ status: 1, data: "AK" }]);
    await db.user.update({ where: { id: userId }, data: { mobile: null } });
    const e = await startPayment(userCtx, { amount: "10", purpose: "School fees" }).catch((x) => x);
    expect(e).toMatchObject({ code: "VALIDATION" });
    expect(JSON.stringify(e.details)).toContain("mobile");
    expect(calls).toHaveLength(0);
    expect(await db.payment.count()).toBe(0);
  });

  it("refuses when the gateway is not configured", async () => {
    clearGateway();
    mockFetch([{}]);
    await expect(startPayment(userCtx, { amount: "10", purpose: "School fees" })).rejects.toMatchObject({ code: "GATEWAY_UNAVAILABLE" });
    expect(await db.payment.count()).toBe(0);
  });

  it("validates the amount and purpose", async () => {
    for (const amount of ["", "abc", "0", "0.5", "-5", "600000"]) {
      await expect(startPayment(userCtx, { amount, purpose: "School fees" })).rejects.toMatchObject({ code: "VALIDATION" });
    }
    await expect(startPayment(userCtx, { amount: "10", purpose: "x" })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("marks the payment FAILED when the gateway rejects the start", async () => {
    mockFetch([{ status: 0, data: "bad" }]);
    await expect(startPayment(userCtx, { amount: "10", purpose: "School fees" })).rejects.toBeTruthy();
    const p = await db.payment.findFirstOrThrow();
    expect(p.status).toBe("FAILED");
    expect((await events("payment.initiate.failed")).length).toBe(1);
  });

  it("only signed-in users can pay (an admin or a visitor cannot)", async () => {
    mockFetch([{ status: 1, data: "AK" }]);
    await expect(startPayment(anonCtx(), { amount: "10", purpose: "School fees" })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(startPayment(adminCtx, { amount: "10", purpose: "School fees" })).rejects.toBeTruthy();
  });
});

describe("callback", () => {
  it("success: marks the payment paid, redirects to the status page, needs no login or origin", async () => {
    const { paymentId, txnId } = await pendingPayment();
    const res = await postCallback(gatewayPayload({ txnid: txnId, amount: "250.00", udf1: paymentId, easepayid: "EZ-77" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain(`/dashboard/payments/${paymentId}`);
    const p = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(p).toMatchObject({ status: "SUCCEEDED", paidAmountPaise: 25000, easebuzzId: "EZ-77" });
    expect(p.paidAt).toBeTruthy();
    // The stored gateway response has no secrets and no card number.
    const stored = JSON.stringify(p.gatewayResponse);
    expect(stored).toContain("EZ-77");
    expect(stored).not.toContain(gatewayPayload({ txnid: txnId, amount: "250.00", udf1: paymentId }).hash);
    expect(stored).not.toContain("1234XXXXXXXX9999");
    expect(stored).not.toContain("TESTSALT");
    const ev = await db.activityEvent.findMany({ where: { paymentId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    expect(ev.map((e) => e.type)).toEqual(["payment.initiated", "payment.redirected", "payment.callback.received", "payment.status.changed"]);
    expect(ev[3]).toMatchObject({ fromStatus: "PENDING", toStatus: "SUCCEEDED", actorType: "GATEWAY", targetUserId: userId, paymentRef: txnId });
  });

  it("failure: marks the payment FAILED with a reason", async () => {
    const { paymentId, txnId } = await pendingPayment();
    await postCallback(gatewayPayload({ txnid: txnId, amount: "250.00", status: "failure", extra: { error_Message: "Insufficient funds" } }));
    const p = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(p).toMatchObject({ status: "FAILED", paidAmountPaise: null, failureReason: "Insufficient funds" });
  });

  it("a user-cancelled payment ends as FAILED", async () => {
    const { paymentId, txnId } = await pendingPayment();
    await postCallback(gatewayPayload({ txnid: txnId, amount: "250.00", status: "userCancelled" }));
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe("FAILED");
  });

  it("replay: the first outcome is kept, a later contradictory callback changes nothing", async () => {
    const { paymentId, txnId } = await pendingPayment();
    const ok = gatewayPayload({ txnid: txnId, amount: "250.00", easepayid: "EZ-1" });
    await postCallback(ok);
    const before = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
    await postCallback(ok);
    await postCallback(gatewayPayload({ txnid: txnId, amount: "250.00", status: "failure", easepayid: "EZ-2" }));
    const after = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(after.status).toBe("SUCCEEDED");
    expect(after.easebuzzId).toBe("EZ-1");
    expect(after.paidAt).toEqual(before.paidAt);
    expect((await events("payment.status.changed")).length).toBe(1);
    expect((await events("payment.callback.rejected")).length).toBe(2);
  });

  it("concurrent identical callbacks change the status exactly once", async () => {
    const { paymentId, txnId } = await pendingPayment();
    const ok = gatewayPayload({ txnid: txnId, amount: "250.00" });
    await Promise.all([postCallback(ok), postCallback(ok), postCallback(ok)]);
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe("SUCCEEDED");
    expect((await events("payment.status.changed")).length).toBe(1);
  });

  it("amount mismatch: a signed 'success' for a different amount is not accepted as paid", async () => {
    const { paymentId, txnId } = await pendingPayment();
    await postCallback(gatewayPayload({ txnid: txnId, amount: "1.00" }));
    const p = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(p.status).toBe("PENDING");
    expect(p.paidAmountPaise).toBeNull();
    expect(p.failureReason).toMatch(/Amount mismatch/);
    expect((await events("payment.callback.rejected")).length).toBe(1);
  });

  it("an unreadable amount is also a mismatch", async () => {
    const { paymentId, txnId } = await pendingPayment();
    await postCallback(gatewayPayload({ txnid: txnId, amount: "abc" }));
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe("PENDING");
  });

  it("bad hash: nothing changes, even for a 'success' with the right amount", async () => {
    const { paymentId, txnId } = await pendingPayment();
    const res = await postCallback(gatewayPayload({ txnid: txnId, amount: "250.00", hash: "f".repeat(128) }));
    expect(res.status).toBe(303);
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe("PENDING");
    expect((await events("payment.callback.rejected"))[0]!.metadata).toMatchObject({ reason: "response check failed" });
  });

  it("missing hash, unknown transaction and junk bodies are rejected without errors", async () => {
    const { paymentId, txnId } = await pendingPayment();
    const noHash = gatewayPayload({ txnid: txnId, amount: "250.00" });
    delete noHash.hash;
    expect((await postCallback(noHash)).status).toBe(303);
    expect((await postCallback(gatewayPayload({ txnid: "YPDOESNOTEXIST", amount: "250.00" }))).status).toBe(303);
    expect((await postCallback({})).status).toBe(303);
    const junk = await (callback.POST as Handler)(req("POST", "/api/payments/callback", { body: [1, 2, 3], origin: null }), seg());
    expect(junk.status).toBe(303);
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe("PENDING");
  });

  it("a pending status leaves the payment open", async () => {
    const { paymentId, txnId } = await pendingPayment();
    await postCallback(gatewayPayload({ txnid: txnId, amount: "250.00", status: "pending" }));
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe("PENDING");
  });

  it("GET never changes anything", async () => {
    const { paymentId, txnId } = await pendingPayment();
    const url = `/api/payments/callback?${new URLSearchParams(gatewayPayload({ txnid: txnId, amount: "250.00" }))}`;
    const res = await (callback.GET as Handler)(req("GET", url), seg());
    expect(res.status).toBe(303);
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe("PENDING");
  });

  it("accepts a JSON body too", async () => {
    const { paymentId, txnId } = await pendingPayment();
    await (callback.POST as Handler)(req("POST", "/api/payments/callback", { body: gatewayPayload({ txnid: txnId, amount: "250.00" }), origin: null }), seg());
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe("SUCCEEDED");
  });
});

describe("reconcile", () => {
  const retrieveReply = (txnid: string, status: string, amount: string) => ({ status: true, msg: { txnid, status, amount, easepayid: "EZ-R1", mode: "UPI" } });

  it("marks a pending payment paid when the gateway says it succeeded", async () => {
    const { paymentId, txnId } = await pendingPayment();
    const calls = mockFetch([retrieveReply(txnId, "success", "250.00")]);
    const r = await reconcilePayment(adminCtx, paymentId);
    expect(r).toMatchObject({ status: "SUCCEEDED", result: "success" });
    expect(calls[0]!.url).toContain("/transaction/v1/retrieve");
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).easebuzzId).toBe("EZ-R1");
    expect((await events("payment.reconciled")).length).toBe(1);
  });

  it("does not trust a different amount", async () => {
    const { paymentId, txnId } = await pendingPayment();
    mockFetch([retrieveReply(txnId, "success", "1.00")]);
    expect((await reconcilePayment(adminCtx, paymentId)).result).toBe("mismatch");
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe("PENDING");
  });

  it("an unclear or other-transaction answer changes nothing", async () => {
    const { paymentId, txnId } = await pendingPayment();
    mockFetch([{ status: false, msg: "not found" }]);
    expect((await reconcilePayment(adminCtx, paymentId)).result).toBe("unknown");
    mockFetch([retrieveReply("YPSOMEOTHER", "success", "250.00")]);
    expect((await reconcilePayment(adminCtx, paymentId)).result).toBe("unknown");
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe("PENDING");
    void txnId;
  });

  it("refuses payments that are already final, and non-admins", async () => {
    const { paymentId, txnId } = await pendingPayment();
    await postCallback(gatewayPayload({ txnid: txnId, amount: "250.00" }));
    mockFetch([{}]);
    await expect(reconcilePayment(adminCtx, paymentId)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(reconcilePayment(userCtx, paymentId)).rejects.toBeTruthy();
  });

  it("reconcilePending checks only old pending payments and reports counts", async () => {
    const a = await pendingPayment();
    const b = await pendingPayment("100");
    await db.payment.update({ where: { id: a.paymentId }, data: { createdAt: new Date(Date.now() - 3600_000) } });
    mockFetch([retrieveReply(a.txnId, "failure", "250.00")]);
    const sum = await reconcilePending(adminCtx, {});
    expect(sum).toMatchObject({ checked: 1, updated: 1, errors: 0 });
    expect((await db.payment.findUniqueOrThrow({ where: { id: a.paymentId } })).status).toBe("FAILED");
    expect((await db.payment.findUniqueOrThrow({ where: { id: b.paymentId } })).status).toBe("PENDING");
  });

  it("reconcilePending stops at the first gateway outage", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = await pendingPayment();
    const b = await pendingPayment("100");
    await db.payment.updateMany({ data: { createdAt: new Date(Date.now() - 3600_000) } });
    const calls = mockFetch([new Error("down")]);
    const sum = await reconcilePending(adminCtx, {});
    expect(sum.errors).toBe(1);
    expect(calls).toHaveLength(1);
    void a; void b;
    err.mockRestore();
  });
});

describe("secrets stay out of logs and activity", () => {
  it("no log line or event contains the key, salt or a hash", async () => {
    const spies = (["log", "error", "warn", "info"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const { txnId } = await pendingPayment();
    const good = gatewayPayload({ txnid: txnId, amount: "250.00" });
    await postCallback({ ...good, hash: "e".repeat(128) });
    await postCallback(good);
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    const stored = JSON.stringify(await db.activityEvent.findMany());
    for (const text of [logged, stored]) {
      expect(text).not.toContain("TESTSALT");
      expect(text).not.toContain("TESTKEY");
      expect(text).not.toContain(good.hash);
      expect(text).not.toContain("e".repeat(128));
    }
    spies.forEach((s) => s.mockRestore());
  });
});

describe("user payment routes", () => {
  it("a user sees only their own payments", async () => {
    const mine = await pendingPayment();
    const other = await makeUser("bina", "+919811111111");
    mockFetch([{ status: 1, data: "AK2" }]);
    const theirs = await startPayment(await ctxFor(other), { amount: "5", purpose: "Other fees" });
    const list = await import("@/app/api/user/payments/route");
    const one = await import("@/app/api/user/payments/[id]/route");
    const cookie = await cookieFor((await db.user.findUniqueOrThrow({ where: { id: userId } })));
    const res = await (list.GET as Handler)(req("GET", "/api/user/payments", { cookie }), seg());
    const body = await res.json();
    expect(body.data.items.map((p: { id: string }) => p.id)).toEqual([mine.paymentId]);
    const own = await (one.GET as Handler)(req("GET", `/api/user/payments/${mine.paymentId}`, { cookie }), seg({ id: mine.paymentId }));
    expect(own.status).toBe(200);
    expect(JSON.stringify(await own.json())).not.toContain("gatewayResponse");
    const foreign = await (one.GET as Handler)(req("GET", `/api/user/payments/${theirs.paymentId}`, { cookie }), seg({ id: theirs.paymentId }));
    expect(foreign.status).toBe(404);
    const anon = await (list.GET as Handler)(req("GET", "/api/user/payments"), seg());
    expect(anon.status).toBe(401);
  });
});
