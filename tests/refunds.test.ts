import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { createRefund, retryRefund } from "@/server/services/refunds";
import { generateRefundHash } from "@/server/gateway/easebuzz";
import * as refundRoute from "@/app/api/admin/payments/[id]/refund/route";
import * as retryRoute from "@/app/api/admin/refunds/[id]/retry/route";
import * as webhook from "@/app/api/payments/refund-webhook/route";
import { cookieFor, ctxFor, makeAdmin, makeAuditor, makeUser, req, resetDb, seg } from "./helpers";
import { CFG, WEBHOOK_TOKEN, clearGateway, configureGateway, mockFetch } from "./gateway-helpers";

type Handler = (r: NextRequest, s: { params: Promise<Record<string, string>> }) => Promise<Response>;

let adminCtx: Awaited<ReturnType<typeof ctxFor>>;
let userId: string;
let paymentId: string;

beforeEach(async () => {
  await resetDb();
  configureGateway();
  const admin = await makeAdmin();
  adminCtx = await ctxFor(admin);
  userId = (await makeUser("asha", "+919876543210")).id;
  // A paid online payment of Rs 100.
  const p = await db.payment.create({
    data: { userId, txnId: "YPTXN0000000000000001", amountPaise: 10000, purpose: "Fees", status: "SUCCEEDED", method: "EASEBUZZ", easebuzzId: "EZ-PAID-1", paidAmountPaise: 10000, paidAt: new Date(), gatewayMode: "test" },
  });
  paymentId = p.id;
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearGateway();
});

const okRefund = (extra: Record<string, unknown> = {}) => ({ status: true, refund_id: "GR-1", ...extra });
const status = async () => (await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).status;
const events = (type: string) => db.activityEvent.findMany({ where: { type }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });

describe("createRefund", () => {
  it("full refund (no amount): sends the exact signed request and records it", async () => {
    const calls = mockFetch([okRefund({ refund_status: "processed" })]);
    const { refund, outcome } = await createRefund(adminCtx, paymentId, {});
    expect(outcome).toBe("processed");
    expect(refund).toMatchObject({ status: "PROCESSED", amountPaise: 10000, gatewayRefundId: "GR-1" });
    expect(refund.merchantRefundId).toMatch(/^YPR[0-9A-F]{16}$/);
    expect(calls[0]!.body.get("merchant_refund_id")).toBe(refund.merchantRefundId);
    expect(calls[0]!.body.get("easebuzz_id")).toBe("EZ-PAID-1");
    expect(calls[0]!.body.get("refund_amount")).toBe("100.00");
    expect(calls[0]!.body.get("hash")).toBe(generateRefundHash(refund.merchantRefundId, "EZ-PAID-1", "100.00", CFG));
    expect(await status()).toBe("REFUNDED");
    expect((await events("refund.requested")).length).toBe(1);
    expect((await events("refund.processed")).length).toBe(1);
  });

  it("partial refund leaves the payment PARTIALLY_REFUNDED, then the rest completes it", async () => {
    mockFetch([okRefund({ refund_status: "refunded" })]);
    await createRefund(adminCtx, paymentId, { amount: "40", reason: "Duplicate" });
    expect(await status()).toBe("PARTIALLY_REFUNDED");
    mockFetch([okRefund({ refund_id: "GR-2", refund_status: "refunded" })]);
    const second = await createRefund(adminCtx, paymentId, { amount: "60.00" });
    expect(second.refund.amountPaise).toBe(6000);
    expect(await status()).toBe("REFUNDED");
    // Nothing left to refund.
    await expect(createRefund(adminCtx, paymentId, {})).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("the sum of refunds can never pass the paid amount", async () => {
    const calls = mockFetch([okRefund({ refund_status: "refunded" })]);
    await createRefund(adminCtx, paymentId, { amount: "70" });
    const over = await createRefund(adminCtx, paymentId, { amount: "30.01" }).catch((e) => e);
    expect(over).toMatchObject({ code: "VALIDATION" });
    expect(over.message).toMatch(/cannot exceed/);
    await expect(createRefund(adminCtx, paymentId, { amount: "100" })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(calls).toHaveLength(1);
    expect(await db.refund.count()).toBe(1);
  });

  it("rejects zero, negative and junk amounts without calling the gateway", async () => {
    const calls = mockFetch([okRefund()]);
    for (const amount of ["0", "-5", "abc", "1.234"]) await expect(createRefund(adminCtx, paymentId, { amount })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(calls).toHaveLength(0);
    expect(await db.refund.count()).toBe(0);
  });

  it("concurrent refunds cannot both pass the limit", async () => {
    mockFetch([okRefund({ refund_status: "refunded" })]);
    const results = await Promise.allSettled([createRefund(adminCtx, paymentId, { amount: "60" }), createRefund(adminCtx, paymentId, { amount: "60" })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.refund.count()).toBe(1);
  });

  it("writes the QUEUED row BEFORE calling the gateway, with a unique id", async () => {
    let seenDuringCall: { status: string; merchantRefundId: string } | null = null;
    vi.stubGlobal("fetch", async (_u: unknown, init?: RequestInit) => {
      const sent = new URLSearchParams(String(init?.body));
      const row = await db.refund.findUnique({ where: { merchantRefundId: sent.get("merchant_refund_id")! } });
      seenDuringCall = row ? { status: row.status, merchantRefundId: row.merchantRefundId } : null;
      return new Response(JSON.stringify(okRefund({ refund_status: "refunded" })));
    });
    await createRefund(adminCtx, paymentId, { amount: "10" });
    expect(seenDuringCall).toMatchObject({ status: "QUEUED" });
    mockFetch([okRefund({ refund_status: "refunded" })]);
    await createRefund(adminCtx, paymentId, { amount: "10" });
    const ids = (await db.refund.findMany()).map((r) => r.merchantRefundId);
    expect(new Set(ids).size).toBe(2);
  });

  it("gateway outage: the row stays QUEUED, still counts against the limit, and the error is shown", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch([new Error("network down")]);
    await expect(createRefund(adminCtx, paymentId, { amount: "80" })).rejects.toMatchObject({ code: "GATEWAY_UNAVAILABLE" });
    const r = await db.refund.findFirstOrThrow();
    expect(r).toMatchObject({ status: "QUEUED", amountPaise: 8000 });
    expect(await status()).toBe("SUCCEEDED");
    // The unknown 80 still counts, so a second 80 is refused instead of risking a double refund.
    const calls = mockFetch([okRefund()]);
    await expect(createRefund(adminCtx, paymentId, { amount: "80" })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(calls).toHaveLength(0);
    err.mockRestore();
  });

  it("a non-JSON gateway reply gives a clear error and the row stays QUEUED", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch(["<html>502 Bad Gateway</html>"]);
    const e = await createRefund(adminCtx, paymentId, { amount: "20" }).catch((x) => x);
    expect(e.message).toMatch(/not JSON/);
    expect((await db.refund.findFirstOrThrow()).status).toBe("QUEUED");
    err.mockRestore();
  });

  it("a refusal from the gateway marks the refund FAILED and frees the amount", async () => {
    mockFetch([{ status: false, reason: "Insufficient settlement balance" }]);
    const { refund, outcome } = await createRefund(adminCtx, paymentId, { amount: "100" });
    expect(outcome).toBe("failed");
    expect(refund).toMatchObject({ status: "FAILED", failureReason: "Insufficient settlement balance" });
    expect(await status()).toBe("SUCCEEDED");
    mockFetch([okRefund({ refund_status: "refunded" })]);
    expect((await createRefund(adminCtx, paymentId, { amount: "100" })).refund.status).toBe("PROCESSED");
    expect((await events("refund.failed")).length).toBe(1);
  });

  it("accepted but not finished stays PROCESSING; the webhook then completes it", async () => {
    mockFetch([okRefund({ refund_status: "queued" })]);
    const { refund } = await createRefund(adminCtx, paymentId, { amount: "100" });
    expect(refund.status).toBe("PROCESSING");
    expect(await status()).toBe("SUCCEEDED");
    const res = await postWebhook({ merchant_refund_id: refund.merchantRefundId, refund_status: "refunded", refund_amount: "100.00", refund_id: "GR-1" });
    expect(res.status).toBe(200);
    expect(await status()).toBe("REFUNDED");
  });

  it("only paid online payments can be refunded", async () => {
    mockFetch([okRefund()]);
    await db.payment.update({ where: { id: paymentId }, data: { status: "PENDING", paidAmountPaise: null } });
    await expect(createRefund(adminCtx, paymentId, {})).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(createRefund(adminCtx, "nope", {})).rejects.toBeTruthy();
  });

  it("refunds are unavailable when the gateway is not configured", async () => {
    clearGateway();
    await expect(createRefund(adminCtx, paymentId, {})).rejects.toMatchObject({ code: "GATEWAY_UNAVAILABLE" });
    expect(await db.refund.count()).toBe(0);
  });

  it("retry re-sends a QUEUED refund with the same merchant refund id", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch([new Error("down")]);
    await createRefund(adminCtx, paymentId, { amount: "30" }).catch(() => {});
    const queued = await db.refund.findFirstOrThrow();
    const calls = mockFetch([okRefund({ refund_status: "refunded" })]);
    const r = await retryRefund(adminCtx, queued.id);
    expect(r.refund.status).toBe("PROCESSED");
    expect(calls[0]!.body.get("merchant_refund_id")).toBe(queued.merchantRefundId);
    await expect(retryRefund(adminCtx, queued.id)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    err.mockRestore();
  });

  it("only an admin can refund: users and the auditor are turned away", async () => {
    const calls = mockFetch([okRefund()]);
    const userCookie = await cookieFor(await db.user.findFirstOrThrow({ where: { id: userId } }));
    const audCookie = await cookieFor(await makeAuditor());
    const adminCookie = await cookieFor(await db.user.findFirstOrThrow({ where: { role: "ADMIN" } }));
    for (const cookie of [userCookie, audCookie, undefined]) {
      const res = await (refundRoute.POST as Handler)(req("POST", `/api/admin/payments/${paymentId}/refund`, { cookie, body: {} }), seg({ id: paymentId }));
      expect([401, 403]).toContain(res.status);
    }
    const retry = await (retryRoute.POST as Handler)(req("POST", "/api/admin/refunds/x/retry", { cookie: audCookie }), seg({ id: "x" }));
    expect(retry.status).toBe(403);
    expect(calls).toHaveLength(0);
    mockFetch([okRefund({ refund_status: "refunded" })]);
    const ok = await (refundRoute.POST as Handler)(req("POST", `/api/admin/payments/${paymentId}/refund`, { cookie: adminCookie, body: { amount: "25" } }), seg({ id: paymentId }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).data.refund.amountPaise).toBe(2500);
  });
});

// ---------- webhook ----------

function postWebhook(body: Record<string, unknown>, o: { token?: string | null; via?: "header" | "query"; hash?: string } = {}) {
  const token = o.token === undefined ? WEBHOOK_TOKEN : o.token;
  const payload = { ...body };
  if (o.hash !== undefined) payload.hash = o.hash;
  const path = token && o.via === "query" ? `/api/payments/refund-webhook?token=${encodeURIComponent(token)}` : "/api/payments/refund-webhook";
  const headers: Record<string, string> = token && o.via !== "query" ? { "x-webhook-token": token } : {};
  return (webhook.POST as Handler)(req("POST", path, { body: payload, headers, origin: null }), seg());
}

async function queuedRefund(amount = "100") {
  mockFetch([okRefund({ refund_status: "queued" })]);
  return (await createRefund(adminCtx, paymentId, { amount })).refund;
}

describe("refund webhook", () => {
  it("rejects a missing, wrong or unset token (401) and changes nothing", async () => {
    const r = await queuedRefund();
    const body = { merchant_refund_id: r.merchantRefundId, refund_status: "refunded", refund_amount: "100.00" };
    expect((await postWebhook(body, { token: null })).status).toBe(401);
    expect((await postWebhook(body, { token: "wrong-token" })).status).toBe(401);
    expect((await postWebhook(body, { token: WEBHOOK_TOKEN + "x" })).status).toBe(401);
    configureGateway({ EASEBUZZ_WEBHOOK_TOKEN: undefined });
    expect((await postWebhook(body, { token: "anything" })).status).toBe(401);
    expect((await db.refund.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("PROCESSING");
    expect((await events("refund.webhook.rejected")).length).toBe(4);
  });

  it("accepts the token in the header or in ?token=", async () => {
    const r = await queuedRefund("50");
    const ok = (await postWebhook({ merchant_refund_id: r.merchantRefundId, refund_status: "refunded", refund_amount: "50.00" }, { via: "query" }));
    expect(ok.status).toBe(200);
    expect((await db.refund.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("PROCESSED");
    const r2 = await queuedRefund("10");
    const ok2 = await postWebhook({ merchant_refund_id: r2.merchantRefundId, refund_status: "refunded", refund_amount: "10.00" }, { via: "header" });
    expect(ok2.status).toBe(200);
  });

  it("never records the token", async () => {
    const r = await queuedRefund();
    const spies = (["log", "error", "warn", "info"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    await postWebhook({ merchant_refund_id: r.merchantRefundId, refund_status: "refunded", refund_amount: "100.00" });
    await postWebhook({ merchant_refund_id: r.merchantRefundId, refund_status: "refunded" }, { token: "guess-12345" });
    const all = JSON.stringify(spies.flatMap((s) => s.mock.calls)) + JSON.stringify(await db.activityEvent.findMany());
    expect(all).not.toContain(WEBHOOK_TOKEN);
    expect(all).not.toContain("guess-12345");
    spies.forEach((s) => s.mockRestore());
  });

  it("verifies the payload hash when one is sent", async () => {
    const r = await queuedRefund();
    const base = { merchant_refund_id: r.merchantRefundId, easebuzz_id: "EZ-PAID-1", refund_status: "refunded", refund_amount: "100.00" };
    const bad = await postWebhook(base, { hash: "0".repeat(128) });
    expect(bad.status).toBe(401);
    expect((await db.refund.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("PROCESSING");
    const good = await postWebhook(base, { hash: generateRefundHash(r.merchantRefundId, "EZ-PAID-1", "100.00", CFG) });
    expect(good.status).toBe(200);
    expect((await db.refund.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("PROCESSED");
  });

  it("EASEBUZZ_WEBHOOK_HASH=off skips the payload hash but still needs the token", async () => {
    configureGateway({ EASEBUZZ_WEBHOOK_HASH: "off" });
    const r = await queuedRefund();
    const res = await postWebhook({ merchant_refund_id: r.merchantRefundId, refund_status: "refunded", refund_amount: "100.00" }, { hash: "garbage" });
    expect(res.status).toBe(200);
    expect((await db.refund.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("PROCESSED");
  });

  it("is idempotent: a replay changes nothing and a late contradiction is ignored", async () => {
    const r = await queuedRefund();
    const done = { merchant_refund_id: r.merchantRefundId, refund_status: "refunded", refund_amount: "100.00" };
    await postWebhook(done);
    await postWebhook(done);
    await postWebhook({ ...done, refund_status: "failed" });
    expect((await db.refund.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("PROCESSED");
    expect((await events("refund.processed")).length).toBe(1);
    expect(await status()).toBe("REFUNDED");
  });

  it("a failed event frees the amount", async () => {
    const r = await queuedRefund();
    await postWebhook({ merchant_refund_id: r.merchantRefundId, refund_status: "failed" });
    expect((await db.refund.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("FAILED");
    expect(await status()).toBe("SUCCEEDED");
  });

  it("an amount that differs from the refund is not accepted as done", async () => {
    const r = await queuedRefund();
    await postWebhook({ merchant_refund_id: r.merchantRefundId, refund_status: "refunded", refund_amount: "1.00" });
    expect((await db.refund.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("PROCESSING");
  });

  it("unknown refunds, junk bodies and non-object bodies are ignored without errors", async () => {
    expect((await postWebhook({ merchant_refund_id: "YPRNOPE", refund_status: "refunded" })).status).toBe(200);
    expect((await postWebhook({})).status).toBe(200);
    const arr = await (webhook.POST as Handler)(req("POST", "/api/payments/refund-webhook", { body: [1], headers: { "x-webhook-token": WEBHOOK_TOKEN }, origin: null }), seg());
    expect(arr.status).toBe(200);
  });

  it("accepts the nested data envelope", async () => {
    const r = await queuedRefund("20");
    const res = await postWebhook({ data: JSON.stringify({ merchant_refund_id: r.merchantRefundId, refund_status: "refunded", refund_amount: "20.00" }) });
    expect(res.status).toBe(200);
    expect((await db.refund.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("PROCESSED");
  });
});
