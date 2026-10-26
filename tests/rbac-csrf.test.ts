import { beforeEach, describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { createQr } from "@/server/services/qr";
import { submitTransaction } from "@/server/services/transactions";
import { sendNotification } from "@/server/services/notifications";
import { sameOrigin } from "@/server/api";
import * as adminStats from "@/app/api/admin/stats/route";
import * as adminUsers from "@/app/api/admin/users/route";
import * as adminUser from "@/app/api/admin/users/[id]/route";
import * as adminQrs from "@/app/api/admin/qrs/route";
import * as adminQr from "@/app/api/admin/qrs/[id]/route";
import * as adminAssign from "@/app/api/admin/qrs/[id]/assignments/route";
import * as adminTxns from "@/app/api/admin/transactions/route";
import * as adminConfirm from "@/app/api/admin/transactions/[id]/confirm/route";
import * as adminReject from "@/app/api/admin/transactions/[id]/reject/route";
import * as adminNotes from "@/app/api/admin/notifications/route";
import * as userTxns from "@/app/api/user/transactions/route";
import * as userRead from "@/app/api/user/notifications/read/route";
import * as qrImage from "@/app/api/qr/[id]/image/route";
import { APP, cookieFor, ctxFor, makeAdmin, makeUser, pngFile, req, resetDb, seg } from "./helpers";

type Handler = (r: NextRequest, s: { params: Promise<Record<string, string>> }) => Promise<Response>;

let adminCookie: string;
let userCookie: string;
let userId: string;
let qrId: string;
let txnRowId: string;

beforeEach(async () => {
  await resetDb();
  const a = await makeAdmin();
  const u = await makeUser("alice", "+919800000001");
  userId = u.id;
  adminCookie = await cookieFor(a);
  userCookie = await cookieFor(u);
  const admin = await ctxFor(a);
  qrId = (await createQr(admin, { label: "Pay", forAll: "true" }, pngFile())).id;
  txnRowId = (await submitTransaction(await ctxFor(u), { qrId, txnId: "RBAC12345678" })).id;
});

// Each admin endpoint with a request builder (cookie plugged in per call).
const adminEndpoints: { name: string; call: (cookie?: string) => Promise<Response> }[] = [
  { name: "GET admin/stats", call: (c) => (adminStats.GET as Handler)(req("GET", "/api/admin/stats", { cookie: c }), seg()) },
  { name: "GET admin/users", call: (c) => (adminUsers.GET as Handler)(req("GET", "/api/admin/users", { cookie: c }), seg()) },
  { name: "GET admin/users/:id", call: (c) => (adminUser.GET as Handler)(req("GET", `/api/admin/users/${userId}`, { cookie: c }), seg({ id: userId })) },
  { name: "PATCH admin/users/:id", call: (c) => (adminUser.PATCH as Handler)(req("PATCH", `/api/admin/users/${userId}`, { cookie: c, body: { status: "DISABLED" } }), seg({ id: userId })) },
  { name: "GET admin/qrs", call: (c) => (adminQrs.GET as Handler)(req("GET", "/api/admin/qrs", { cookie: c }), seg()) },
  { name: "POST admin/qrs", call: (c) => (adminQrs.POST as Handler)(req("POST", "/api/admin/qrs", { cookie: c, body: { label: "Nope" } }), seg()) },
  { name: "PATCH admin/qrs/:id", call: (c) => (adminQr.PATCH as Handler)(req("PATCH", `/api/admin/qrs/${qrId}`, { cookie: c, body: { label: "Changed" } }), seg({ id: qrId })) },
  { name: "DELETE admin/qrs/:id", call: (c) => (adminQr.DELETE as Handler)(req("DELETE", `/api/admin/qrs/${qrId}`, { cookie: c }), seg({ id: qrId })) },
  { name: "POST admin/qrs/:id/assignments", call: (c) => (adminAssign.POST as Handler)(req("POST", `/api/admin/qrs/${qrId}/assignments`, { cookie: c, body: { userId } }), seg({ id: qrId })) },
  { name: "DELETE admin/qrs/:id/assignments", call: (c) => (adminAssign.DELETE as Handler)(req("DELETE", `/api/admin/qrs/${qrId}/assignments`, { cookie: c, body: { userId } }), seg({ id: qrId })) },
  { name: "GET admin/transactions", call: (c) => (adminTxns.GET as Handler)(req("GET", "/api/admin/transactions", { cookie: c }), seg()) },
  { name: "POST admin/transactions/:id/confirm", call: (c) => (adminConfirm.POST as Handler)(req("POST", `/api/admin/transactions/${txnRowId}/confirm`, { cookie: c }), seg({ id: txnRowId })) },
  { name: "POST admin/transactions/:id/reject", call: (c) => (adminReject.POST as Handler)(req("POST", `/api/admin/transactions/${txnRowId}/reject`, { cookie: c, body: { reason: "No payment" } }), seg({ id: txnRowId })) },
  { name: "GET admin/notifications", call: (c) => (adminNotes.GET as Handler)(req("GET", "/api/admin/notifications", { cookie: c }), seg()) },
  { name: "POST admin/notifications", call: (c) => (adminNotes.POST as Handler)(req("POST", "/api/admin/notifications", { cookie: c, body: { title: "Hello", body: "World" } }), seg()) },
];

describe("admin APIs", () => {
  it.each(adminEndpoints)("$name needs a session", async ({ call }) => {
    const res = await call(undefined);
    expect(res.status).toBe(401);
  });

  it.each(adminEndpoints)("$name refuses a signed-in user", async ({ call }) => {
    const res = await call(userCookie);
    expect(res.status).toBe(403);
    expect(await db.transaction.findUnique({ where: { id: txnRowId } })).toMatchObject({ status: "PENDING" });
    expect((await db.user.findUnique({ where: { id: userId } }))?.status).toBe("ACTIVE");
  });

  it("refuses a garbage or tampered session cookie", async () => {
    const res = await (adminStats.GET as Handler)(req("GET", "/api/admin/stats", { cookie: `${adminCookie}x` }), seg());
    expect(res.status).toBe(401);
  });

  it("lets an admin through", async () => {
    for (const e of adminEndpoints.filter((x) => x.name.startsWith("GET"))) {
      const res = await e.call(adminCookie);
      expect(res.status, e.name).toBe(200);
    }
    const res = await (adminConfirm.POST as Handler)(req("POST", `/api/admin/transactions/${txnRowId}/confirm`, { cookie: adminCookie }), seg({ id: txnRowId }));
    expect(res.status).toBe(200);
    expect((await db.transaction.findUnique({ where: { id: txnRowId } }))?.status).toBe("CONFIRMED");
  });

  it("does not leak password hashes in the users list", async () => {
    const res = await (adminUsers.GET as Handler)(req("GET", "/api/admin/users", { cookie: adminCookie }), seg());
    const text = await res.text();
    expect(text).toContain("alice");
    expect(text).not.toMatch(/passwordHash|argon2/i);
  });
});

describe("user APIs", () => {
  it("need a session", async () => {
    const r1 = await (userTxns.POST as Handler)(req("POST", "/api/user/transactions", { body: { qrId, txnId: "ANON12345678" } }), seg());
    const r2 = await (userRead.POST as Handler)(req("POST", "/api/user/notifications/read", { body: { all: true } }), seg());
    expect([r1.status, r2.status]).toEqual([401, 401]);
  });

  it("refuse an admin session", async () => {
    const r1 = await (userTxns.POST as Handler)(req("POST", "/api/user/transactions", { cookie: adminCookie, body: { qrId, txnId: "ADMIN2345678" } }), seg());
    const r2 = await (userRead.POST as Handler)(req("POST", "/api/user/notifications/read", { cookie: adminCookie, body: { all: true } }), seg());
    expect([r1.status, r2.status]).toEqual([403, 403]);
  });

  it("work for a user, with the standard JSON shape", async () => {
    const ok = await (userTxns.POST as Handler)(req("POST", "/api/user/transactions", { cookie: userCookie, body: { qrId, txnId: "good12345678" } }), seg());
    expect(ok.status).toBe(200);
    expect((await ok.json()).data).toMatchObject({ txnId: "GOOD12345678", status: "PENDING" });
    const dup = await (userTxns.POST as Handler)(req("POST", "/api/user/transactions", { cookie: userCookie, body: { qrId, txnId: "GOOD12345678" } }), seg());
    expect(dup.status).toBe(409);
    expect((await dup.json()).error.code).toBe("CONFLICT");
    const bad = await (userTxns.POST as Handler)(req("POST", "/api/user/transactions", { cookie: userCookie, body: { qrId, txnId: "x" } }), seg());
    expect(bad.status).toBe(422);
  });

  it("marks notifications read over HTTP", async () => {
    await sendNotification(await ctxFor((await db.user.findFirst({ where: { role: "ADMIN" } }))!), { userId, title: "Hi", body: "there" });
    const res = await (userRead.POST as Handler)(req("POST", "/api/user/notifications/read", { cookie: userCookie, body: { all: true } }), seg());
    expect((await res.json()).data).toEqual({ marked: 1 });
  });
});

describe("QR image route", () => {
  it("needs a session and hides QRs the user cannot see", async () => {
    const anon = await (qrImage.GET as Handler)(req("GET", `/api/qr/${qrId}/image`), seg({ id: qrId }));
    expect(anon.status).toBe(401);
    await db.qr.update({ where: { id: qrId }, data: { forAll: false } });
    const hidden = await (qrImage.GET as Handler)(req("GET", `/api/qr/${qrId}/image`, { cookie: userCookie }), seg({ id: qrId }));
    expect(hidden.status).toBe(404);
    const admin = await (qrImage.GET as Handler)(req("GET", `/api/qr/${qrId}/image`, { cookie: adminCookie }), seg({ id: qrId }));
    expect(admin.status).toBe(200);
    expect(admin.headers.get("content-type")).toBe("image/png");
    expect(admin.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("CSRF / origin check", () => {
  const post = (headers: Record<string, string>, cookie = userCookie) =>
    (userTxns.POST as Handler)(
      req("POST", "/api/user/transactions", { cookie, origin: null, headers, body: { qrId, txnId: `CSRF${Math.random().toString(36).slice(2, 10).toUpperCase()}` } }),
      seg(),
    );

  it("blocks a request from a different origin host", async () => {
    const res = await post({ origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toMatch(/cross-site/i);
  });

  it("blocks a lookalike host and a different port", async () => {
    expect((await post({ origin: "http://localhost.evil.example" })).status).toBe(403);
    expect((await post({ origin: "http://localhost:4000" })).status).toBe(403);
    expect((await post({ origin: "http://localhost:3000.evil.example" })).status).toBe(403);
  });

  it("blocks browser-marked cross-site requests even with a matching Origin", async () => {
    const res = await post({ origin: APP, "sec-fetch-site": "cross-site" });
    expect(res.status).toBe(403);
  });

  it("blocks a request with no Origin and no same-origin marker", async () => {
    expect((await post({})).status).toBe(403);
    expect((await post({ "sec-fetch-site": "same-site" })).status).toBe(403);
  });

  it("blocks an opaque 'null' origin and a garbage origin", async () => {
    expect((await post({ origin: "null" })).status).toBe(403);
    expect((await post({ origin: "not a url" })).status).toBe(403);
  });

  it("allows the app's own origin", async () => {
    expect((await post({ origin: APP })).status).toBe(200);
  });

  it("allows browser-marked same-origin requests without an Origin header", async () => {
    expect((await post({ "sec-fetch-site": "same-origin" })).status).toBe(200);
  });

  it("allows a matching Origin when the browser says same-site (e.g. localhost vs 127.0.0.1)", async () => {
    expect((await post({ origin: APP, "sec-fetch-site": "same-site" })).status).toBe(200);
  });

  it("allows the proxy-forwarded host", async () => {
    const r = req("POST", "/api/user/transactions", { origin: "https://panel.example.org", headers: { "x-forwarded-host": "panel.example.org" } });
    expect(sameOrigin(r)).toBe(true);
    const evil = req("POST", "/api/user/transactions", { origin: "https://evil.example", headers: { "x-forwarded-host": "panel.example.org" } });
    expect(sameOrigin(evil)).toBe(false);
  });

  it("does not check safe methods", async () => {
    const res = await (adminStats.GET as Handler)(req("GET", "/api/admin/stats", { cookie: adminCookie, headers: { origin: "https://evil.example" } }), seg());
    expect(res.status).toBe(200);
  });

  it("applies to admin mutations too, and nothing changes when blocked", async () => {
    const res = await (adminConfirm.POST as Handler)(
      req("POST", `/api/admin/transactions/${txnRowId}/confirm`, { cookie: adminCookie, origin: "https://evil.example" }),
      seg({ id: txnRowId }),
    );
    expect(res.status).toBe(403);
    expect((await db.transaction.findUnique({ where: { id: txnRowId } }))?.status).toBe("PENDING");
  });
});
