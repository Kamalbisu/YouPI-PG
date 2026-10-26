import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { createQr } from "@/server/services/qr";
import { submitTransaction, confirmTransaction } from "@/server/services/transactions";
import { sendNotification } from "@/server/services/notifications";
import { createAuditor } from "@/server/services/auditors";
import { createRefund } from "@/server/services/refunds";
import { listActivity, paymentTimeline, userTimeline } from "@/server/services/activity";
import { startPayment, handlePaymentCallback } from "@/server/services/payments";
import { auditorLogin, userLogin } from "@/server/services/auth";
import * as login from "@/app/api/auditor/auth/login/route";
import * as feed from "@/app/api/auditor/activity/route";
import * as csv from "@/app/api/auditor/activity/export/route";
import * as payTimeline from "@/app/api/auditor/payments/[id]/route";
import * as userTl from "@/app/api/auditor/users/[id]/route";
import * as adminAuditors from "@/app/api/admin/auditors/route";
import * as adminPayments from "@/app/api/admin/payments/route";
import * as adminPayment from "@/app/api/admin/payments/[id]/route";
import * as adminRefund from "@/app/api/admin/payments/[id]/refund/route";
import * as adminReconcile from "@/app/api/admin/payments/[id]/reconcile/route";
import * as adminReconcileAll from "@/app/api/admin/payments/reconcile/route";
import * as adminRetry from "@/app/api/admin/refunds/[id]/retry/route";
import * as adminGateway from "@/app/api/admin/gateway/route";
import * as adminStats from "@/app/api/admin/stats/route";
import * as adminUsers from "@/app/api/admin/users/route";
import * as adminUser from "@/app/api/admin/users/[id]/route";
import * as adminQrs from "@/app/api/admin/qrs/route";
import * as adminQr from "@/app/api/admin/qrs/[id]/route";
import * as adminConfirm from "@/app/api/admin/transactions/[id]/confirm/route";
import * as adminReject from "@/app/api/admin/transactions/[id]/reject/route";
import * as adminNotes from "@/app/api/admin/notifications/route";
import * as userTxns from "@/app/api/user/transactions/route";
import * as userPayments from "@/app/api/user/payments/route";
import * as userRead from "@/app/api/user/notifications/read/route";
import { PASSWORD, anonCtx, cookieFor, ctxFor, makeAdmin, makeAuditor, makeUser, pngFile, req, resetDb, seg } from "./helpers";
import { clearGateway, configureGateway, gatewayPayload, mockFetch } from "./gateway-helpers";

type Handler = (r: NextRequest, s: { params: Promise<Record<string, string>> }) => Promise<Response>;

let adminCookie: string, auditorCookie: string, userCookie: string;
let adminCtx: Awaited<ReturnType<typeof ctxFor>>, auditorCtx: Awaited<ReturnType<typeof ctxFor>>, userCtx: Awaited<ReturnType<typeof ctxFor>>;
let userId: string, qrId: string, paymentId: string, txnRowId: string;

beforeEach(async () => {
  await resetDb();
  configureGateway();
  const a = await makeAdmin();
  const au = await makeAuditor();
  const u = await makeUser("alice", "+919800000001");
  userId = u.id;
  [adminCookie, auditorCookie, userCookie] = await Promise.all([cookieFor(a), cookieFor(au), cookieFor(u)]);
  [adminCtx, auditorCtx, userCtx] = await Promise.all([ctxFor(a), ctxFor(au), ctxFor(u)]);
  qrId = (await createQr(adminCtx, { label: "Pay", forAll: "true" }, pngFile())).id;
  txnRowId = (await submitTransaction(userCtx, { qrId, txnId: "AUD123456789" })).id;
  const p = await db.payment.create({
    data: { userId, txnId: "YPTXN0000000000000009", amountPaise: 10000, purpose: "Fees", status: "SUCCEEDED", method: "EASEBUZZ", easebuzzId: "EZ-9", paidAmountPaise: 10000, paidAt: new Date(), gatewayMode: "test" },
  });
  paymentId = p.id;
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearGateway();
});

const types = async () => (await db.activityEvent.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] })).map((e) => e.type);

describe("Admin 2 cannot change anything", () => {
  const write = (name: string, h: unknown, path: string, body?: unknown, params: Record<string, string> = {}) => ({
    name,
    call: (cookie?: string) => (h as Handler)(req(name.split(" ")[0]!, path, { cookie, body }), seg(params)),
  });
  const writes = () => [
    write("POST admin/auditors", adminAuditors.POST, "/api/admin/auditors", { name: "X Y", email: "x@example.com", username: "xy", password: PASSWORD }),
    write("POST admin/qrs", adminQrs.POST, "/api/admin/qrs", { label: "Nope" }),
    write("PATCH admin/qrs/:id", adminQr.PATCH, `/api/admin/qrs/${qrId}`, { label: "Changed" }, { id: qrId }),
    write("DELETE admin/qrs/:id", adminQr.DELETE, `/api/admin/qrs/${qrId}`, undefined, { id: qrId }),
    write("PATCH admin/users/:id", adminUser.PATCH, `/api/admin/users/${userId}`, { status: "DISABLED" }, { id: userId }),
    write("POST admin/transactions/:id/confirm", adminConfirm.POST, `/api/admin/transactions/${txnRowId}/confirm`, undefined, { id: txnRowId }),
    write("POST admin/transactions/:id/reject", adminReject.POST, `/api/admin/transactions/${txnRowId}/reject`, { reason: "No payment" }, { id: txnRowId }),
    write("POST admin/notifications", adminNotes.POST, "/api/admin/notifications", { title: "Hello", body: "World" }),
    write("POST admin/payments/:id/refund", adminRefund.POST, `/api/admin/payments/${paymentId}/refund`, { amount: "10" }, { id: paymentId }),
    write("POST admin/payments/:id/reconcile", adminReconcile.POST, `/api/admin/payments/${paymentId}/reconcile`, undefined, { id: paymentId }),
    write("POST admin/payments/reconcile", adminReconcileAll.POST, "/api/admin/payments/reconcile"),
    write("POST admin/refunds/:id/retry", adminRetry.POST, "/api/admin/refunds/x/retry", undefined, { id: "x" }),
    write("POST user/transactions", userTxns.POST, "/api/user/transactions", { qrId, txnId: "NEWTXN123456" }),
    write("POST user/payments", userPayments.POST, "/api/user/payments", { amount: "10", purpose: "Fees" }),
    write("POST user/notifications/read", userRead.POST, "/api/user/notifications/read", {}),
  ];

  it("every write endpoint answers 403 to the auditor and changes nothing", async () => {
    const calls = mockFetch([{}]);
    const before = { events: await db.activityEvent.count(), txns: await db.transaction.count(), pays: await db.payment.count(), users: await db.user.count(), refunds: await db.refund.count(), qrs: await db.qr.count() };
    for (const w of writes()) {
      const res = await w.call(auditorCookie);
      expect({ name: w.name, status: res.status }).toEqual({ name: w.name, status: 403 });
    }
    expect(calls).toHaveLength(0);
    expect(before).toEqual({ events: await db.activityEvent.count(), txns: await db.transaction.count(), pays: await db.payment.count(), users: await db.user.count(), refunds: await db.refund.count(), qrs: await db.qr.count() });
    expect((await db.transaction.findUniqueOrThrow({ where: { id: txnRowId } })).status).toBe("PENDING");
  });

  it("admin read endpoints are closed to the auditor too", async () => {
    const reads: [string, unknown, string, Record<string, string>?][] = [
      ["payments", adminPayments.GET, "/api/admin/payments"],
      ["payment", adminPayment.GET, `/api/admin/payments/${paymentId}`, { id: paymentId }],
      ["gateway", adminGateway.GET, "/api/admin/gateway"],
      ["stats", adminStats.GET, "/api/admin/stats"],
      ["users", adminUsers.GET, "/api/admin/users"],
      ["auditors", adminAuditors.GET, "/api/admin/auditors"],
    ];
    for (const [name, h, path, params] of reads) {
      const res = await (h as Handler)(req("GET", path, { cookie: auditorCookie }), seg(params));
      expect({ name, status: res.status }).toEqual({ name, status: 403 });
    }
  });

  it("the auditor routes only offer GET (plus login)", () => {
    for (const mod of [feed, csv, payTimeline, userTl] as Record<string, unknown>[]) {
      for (const verb of ["POST", "PUT", "PATCH", "DELETE"]) expect(mod[verb]).toBeUndefined();
      expect(mod.GET).toBeTypeOf("function");
    }
  });
});

describe("Admin 2 reads", () => {
  const get = (h: unknown, path: string, cookie?: string, params: Record<string, string> = {}) => (h as Handler)(req("GET", path, { cookie }), seg(params));

  it("only the auditor can read the trace", async () => {
    for (const [h, path, params] of [
      [feed.GET, "/api/auditor/activity", {}],
      [csv.GET, "/api/auditor/activity/export", {}],
      [payTimeline.GET, `/api/auditor/payments/${paymentId}`, { id: paymentId }],
      [userTl.GET, `/api/auditor/users/${userId}`, { id: userId }],
    ] as [unknown, string, Record<string, string>][]) {
      expect((await get(h, path, undefined, params)).status).toBe(401);
      expect((await get(h, path, userCookie, params)).status).toBe(403);
      expect((await get(h, path, adminCookie, params)).status).toBe(403);
      expect((await get(h, path, auditorCookie, params)).status).toBe(200);
    }
  });

  it("the auditor login works only for auditor accounts", async () => {
    await expect(auditorLogin(anonCtx(), { login: "auditor@example.com", password: PASSWORD })).resolves.toMatchObject({ role: "AUDITOR" });
    await expect(auditorLogin(anonCtx(), { login: "admin@example.com", password: PASSWORD })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(auditorLogin(anonCtx(), { login: "alice", password: PASSWORD })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(auditorLogin(anonCtx(), { login: "auditor@example.com", password: "nope-nope-nope-1" })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    // The ordinary client login does not let the auditor in either.
    await expect(userLogin(anonCtx(), { username: "auditor", password: PASSWORD })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    const t = await types();
    expect(t).toContain("auth.login.success");
    expect(t.filter((x) => x === "auth.login.failed").length).toBeGreaterThanOrEqual(4);
    // The login route exists and is POST-only.
    expect(login.POST).toBeTypeOf("function");
    expect((login as Record<string, unknown>).GET).toBeUndefined();
  });

  it("filters by user, payment, actor, type and date, and searches", async () => {
    await createRefund(adminCtx, paymentId, { amount: "10" }).catch(() => {});
    const all = await listActivity(auditorCtx, {});
    expect(all.total).toBeGreaterThan(3);

    const byUser = await listActivity(auditorCtx, { userId });
    expect(byUser.items.every((e) => e.targetUserId === userId)).toBe(true);
    expect(byUser.items.length).toBeGreaterThan(0);

    const byPayment = await listActivity(auditorCtx, { paymentId });
    expect(byPayment.items.length).toBeGreaterThan(0);
    expect(byPayment.items.every((e) => e.paymentId === paymentId)).toBe(true);

    const byActor = await listActivity(auditorCtx, { actorType: "ADMIN" });
    expect(byActor.items.length).toBeGreaterThan(0);
    expect(byActor.items.every((e) => e.actorType === "ADMIN")).toBe(true);

    const family = await listActivity(auditorCtx, { type: "qr" });
    expect(family.items.length).toBeGreaterThan(0);
    expect(family.items.every((e) => e.type.startsWith("qr."))).toBe(true);
    const exact = await listActivity(auditorCtx, { type: "qr.created" });
    expect(exact.items.map((e) => e.type)).toEqual(["qr.created"]);

    const today = new Date().toISOString().slice(0, 10);
    expect((await listActivity(auditorCtx, { from: today, to: today })).total).toBe(all.total);
    expect((await listActivity(auditorCtx, { from: "2001-01-01", to: "2001-01-02" })).total).toBe(0);

    const search = await listActivity(auditorCtx, { q: "aud123456789" });
    expect(search.items.map((e) => e.paymentRef)).toContain("AUD123456789");
    await expect(listActivity(auditorCtx, { from: "yesterday" })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("paginates", async () => {
    for (let i = 0; i < 5; i++) await sendNotification(adminCtx, { title: `Hello ${i}`, body: "Body text", toAll: "true" }).catch(() => {});
    const p1 = await listActivity(auditorCtx, { pageSize: "3", page: "1" });
    const p2 = await listActivity(auditorCtx, { pageSize: "3", page: "2" });
    expect(p1.items).toHaveLength(3);
    expect(p1.total).toBe(p2.total);
    expect(p1.items.map((e) => e.id).filter((id) => p2.items.some((x) => x.id === id))).toEqual([]);
  });

  it("CSV export carries the filters, has a header, protects against formulas, and has no secrets", async () => {
    await db.activityEvent.create({ data: { type: "payment.status.changed", actorType: "SYSTEM", paymentRef: "=HYPERLINK(1)", metadata: { note: "x" } } });
    const res = await get(csv.GET, "/api/auditor/activity/export?type=payment", auditorCookie);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const text = await res.text();
    expect(text.split("\n")[0]).toBe("time,event,actor_type,actor,target_user_id,payment_id,payment_ref,refund_id,from_status,to_status,ip,user_agent,details");
    expect(text).toContain(`"'=HYPERLINK(1)"`);
    expect(text).not.toMatch(/TESTSALT|TESTKEY|hook-token/);
    expect(text).not.toContain("auth.login");
  });

  it("builds a payment timeline (oldest first, with refunds) and a user timeline", async () => {
    mockFetch([{ status: true, refund_id: "G1", refund_status: "refunded" }]);
    await createRefund(adminCtx, paymentId, { amount: "40" });
    const t = await paymentTimeline(auditorCtx, paymentId);
    expect(t!.payment.refunds).toHaveLength(1);
    expect(t!.payment).not.toHaveProperty("gatewayResponse");
    expect(t!.events.map((e) => e.type)).toEqual(expect.arrayContaining(["refund.requested", "refund.processed"]));
    const times = t!.events.map((e) => e.createdAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(await paymentTimeline(auditorCtx, "missing")).toBeNull();
    const res = await get(payTimeline.GET, "/api/auditor/payments/missing", auditorCookie, { id: "missing" });
    expect(res.status).toBe(404);

    const ut = await userTimeline(auditorCtx, userId, {});
    expect(ut!.events.items.length).toBeGreaterThan(0);
    expect(ut!.user).not.toHaveProperty("passwordHash");
    expect(await userTimeline(auditorCtx, "missing", {})).toBeNull();
    // Non-auditors are refused at the service level too.
    await expect(paymentTimeline(adminCtx, paymentId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listActivity(userCtx, {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listActivity(anonCtx(), {})).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});

describe("creating Admin 2 accounts", () => {
  it("the admin can create one; it can sign in; the event is traced", async () => {
    const res = await (adminAuditors.POST as Handler)(
      req("POST", "/api/admin/auditors", { cookie: adminCookie, body: { name: "Meera Rao", email: "meera@example.com", username: "meera", password: PASSWORD } }),
      seg(),
    );
    expect(res.status).toBe(200);
    const row = await db.user.findUniqueOrThrow({ where: { email: "meera@example.com" } });
    expect(row.role).toBe("AUDITOR");
    expect(row.passwordHash).not.toBe(PASSWORD);
    await expect(auditorLogin(anonCtx(), { login: "meera@example.com", password: PASSWORD })).resolves.toMatchObject({ role: "AUDITOR" });
    const ev = await db.activityEvent.findFirstOrThrow({ where: { type: "auditor.created" } });
    expect(ev).toMatchObject({ actorType: "ADMIN", targetUserId: row.id });
    expect(JSON.stringify(ev.metadata)).not.toContain(PASSWORD);
    // duplicate
    await expect(createAuditor(adminCtx, { name: "Meera Rao", email: "meera@example.com", username: "meera2", password: PASSWORD })).rejects.toMatchObject({ code: "CONFLICT" });
    // Weak password
    await expect(createAuditor(adminCtx, { name: "Meera Rao", email: "m2@example.com", username: "meera3", password: "short" })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("users and the auditor cannot create accounts", async () => {
    await expect(createAuditor(userCtx, { name: "A B", email: "a@example.com", username: "ab", password: PASSWORD })).rejects.toBeTruthy();
    await expect(createAuditor(auditorCtx, { name: "A B", email: "a@example.com", username: "ab", password: PASSWORD })).rejects.toBeTruthy();
    expect(await db.user.count({ where: { role: "AUDITOR" } })).toBe(1);
  });
});

describe("the trace is written everywhere it should be", () => {
  it("manual transaction, QR and notification actions", async () => {
    await confirmTransaction(adminCtx, txnRowId);
    await sendNotification(adminCtx, { title: "Hello", body: "World", toAll: "true" });
    const t = await types();
    for (const x of ["qr.created", "txn.manual.submitted", "txn.manual.confirmed", "notification.sent"]) expect(t).toContain(x);
    const confirmed = await db.activityEvent.findFirstOrThrow({ where: { type: "txn.manual.confirmed" } });
    expect(confirmed).toMatchObject({ actorType: "ADMIN", targetUserId: userId, paymentRef: "AUD123456789", fromStatus: "PENDING", toStatus: "CONFIRMED", ip: "203.0.113.9", userAgent: "vitest" });
    expect(confirmed.transactionId).toBe(txnRowId);
  });

  it("an online payment from start to finish, each step with who/what/before/after", async () => {
    mockFetch([{ status: 1, data: "ACCESSKEY123" }]);
    const started = await startPayment(userCtx, { amount: "250", purpose: "Fees" });
    const p = await db.payment.findFirstOrThrow({ where: { txnId: started.txnId } });
    const res = await handlePaymentCallback(anonCtx(), gatewayPayload({ txnid: p.txnId, amount: "250.00", status: "success", easepayid: "EZ-X" }));
    expect(res).toMatchObject({ paymentId: p.id, result: "success" });
    const evs = await db.activityEvent.findMany({ where: { paymentId: p.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    expect(evs.map((e) => e.type)).toEqual(expect.arrayContaining(["payment.initiated", "payment.redirected", "payment.callback.received", "payment.status.changed"]));
    const changed = evs.find((e) => e.type === "payment.status.changed")!;
    expect(changed).toMatchObject({ toStatus: "SUCCEEDED", targetUserId: userId, paymentRef: p.txnId });
    expect(changed.fromStatus).toBeTruthy();
    expect(JSON.stringify(evs)).not.toMatch(/TESTSALT|TESTKEY|1234XXXXXXXX9999/);
  });

  it("record the actor, ip and user agent of a signed-in action", async () => {
    const ev = await db.activityEvent.findFirstOrThrow({ where: { type: "txn.manual.submitted" } });
    expect(ev).toMatchObject({ actorType: "USER", actorId: userId, actorName: "alice", ip: "203.0.113.9", userAgent: "vitest" });
  });
});

describe("the trace cannot be edited", () => {
  it("the database refuses UPDATE and DELETE", async () => {
    const e = await db.activityEvent.findFirstOrThrow();
    await expect(db.activityEvent.update({ where: { id: e.id }, data: { type: "x.y" } })).rejects.toThrow();
    await expect(db.activityEvent.delete({ where: { id: e.id } })).rejects.toThrow();
    await expect(db.activityEvent.deleteMany({})).rejects.toThrow();
    await expect(db.$executeRawUnsafe(`UPDATE "activity_events" SET "type" = 'x.y'`)).rejects.toThrow();
    expect((await db.activityEvent.findUniqueOrThrow({ where: { id: e.id } })).type).toBe(e.type);
  });
});
