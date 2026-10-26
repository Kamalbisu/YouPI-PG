import { beforeEach, describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { cookieName } from "@/server/auth/session";
import * as adminClients from "@/app/api/admin/clients/route";
import * as adminClient from "@/app/api/admin/clients/[id]/route";
import * as adminClientPerms from "@/app/api/admin/clients/[id]/permissions/route";
import * as adminClientSuspend from "@/app/api/admin/clients/[id]/suspend/route";
import * as adminClientReactivate from "@/app/api/admin/clients/[id]/reactivate/route";
import * as adminClientReset from "@/app/api/admin/clients/[id]/reset-password/route";
import * as adminClientActivity from "@/app/api/admin/clients/[id]/login-activity/route";
import * as adminBusinesses from "@/app/api/admin/businesses/route";
import * as adminBusiness from "@/app/api/admin/businesses/[id]/route";
import * as adminBizApprove from "@/app/api/admin/businesses/[id]/approve/route";
import * as adminBizReject from "@/app/api/admin/businesses/[id]/reject/route";
import * as adminBizSuspend from "@/app/api/admin/businesses/[id]/suspend/route";
import * as adminBizReactivate from "@/app/api/admin/businesses/[id]/reactivate/route";
import * as adminAudit from "@/app/api/admin/audit-logs/route";
import * as adminAuditExport from "@/app/api/admin/audit-logs/export/route";
import * as adminSettings from "@/app/api/admin/settings/route";
import * as adminSupport from "@/app/api/admin/support/route";
import * as adminTicket from "@/app/api/admin/support/[id]/route";
import * as adminTicketReply from "@/app/api/admin/support/[id]/reply/route";
import * as clientBusinesses from "@/app/api/client/businesses/route";
import * as clientBusiness from "@/app/api/client/businesses/[id]/route";
import * as clientLogo from "@/app/api/client/businesses/[id]/logo/route";
import * as clientTeam from "@/app/api/client/businesses/[id]/team/route";
import * as clientTeamMember from "@/app/api/client/businesses/[id]/team/[userId]/route";
import * as clientSupport from "@/app/api/client/support/route";
import * as clientTicket from "@/app/api/client/support/[id]/route";
import * as clientTicketReply from "@/app/api/client/support/[id]/reply/route";
import * as clientProfile from "@/app/api/client/profile/route";
import { resetDb } from "./helpers";
import { adminSession, fileOf, makeClientTenant, makeManager, PNG_BYTES, req, seg, type Tenant } from "./helpers-admin";

type Handler = (r: NextRequest, s: { params: Promise<never> }) => Promise<Response>;
interface Case {
  name: string;
  run: (cookie?: string, headers?: Record<string, string>) => Promise<Response>;
}

/** Build a route call: handler, method, path, route params and an optional JSON body. */
function c(name: string, handler: unknown, method: string, path: string, params: Record<string, string> = {}, body?: unknown): Case {
  return {
    name,
    run: (cookie, headers) => (handler as Handler)(req(method, path, { cookie, body, headers }), seg(params) as never),
  };
}

interface Ids { clientId: string; businessId: string; ticketId: string; userId: string }

/** Every admin-only route handler in this slice. */
function adminCases(i: Ids): Case[] {
  return [
    c("GET /admin/clients", adminClients.GET, "GET", "/api/admin/clients"),
    c("POST /admin/clients", adminClients.POST, "POST", "/api/admin/clients", {}, { name: "Zed Traders", contactName: "Zed Z", email: "zed@zed.test", maxBusinesses: 1 }),
    c("GET /admin/clients/:id", adminClient.GET, "GET", `/api/admin/clients/${i.clientId}`, { id: i.clientId }),
    c("PATCH /admin/clients/:id", adminClient.PATCH, "PATCH", `/api/admin/clients/${i.clientId}`, { id: i.clientId }, { name: "Renamed" }),
    c("PUT /admin/clients/:id/permissions", adminClientPerms.PUT, "PUT", `/api/admin/clients/${i.clientId}/permissions`, { id: i.clientId }, { permissions: ["support.use"] }),
    c("POST /admin/clients/:id/suspend", adminClientSuspend.POST, "POST", `/api/admin/clients/${i.clientId}/suspend`, { id: i.clientId }, { reason: "Testing access control" }),
    c("POST /admin/clients/:id/reactivate", adminClientReactivate.POST, "POST", `/api/admin/clients/${i.clientId}/reactivate`, { id: i.clientId }, {}),
    c("POST /admin/clients/:id/reset-password", adminClientReset.POST, "POST", `/api/admin/clients/${i.clientId}/reset-password`, { id: i.clientId }, {}),
    c("GET /admin/clients/:id/login-activity", adminClientActivity.GET, "GET", `/api/admin/clients/${i.clientId}/login-activity`, { id: i.clientId }),
    c("GET /admin/businesses", adminBusinesses.GET, "GET", "/api/admin/businesses"),
    c("GET /admin/businesses/:id", adminBusiness.GET, "GET", `/api/admin/businesses/${i.businessId}`, { id: i.businessId }),
    c("POST /admin/businesses/:id/approve", adminBizApprove.POST, "POST", `/api/admin/businesses/${i.businessId}/approve`, { id: i.businessId }, {}),
    c("POST /admin/businesses/:id/reject", adminBizReject.POST, "POST", `/api/admin/businesses/${i.businessId}/reject`, { id: i.businessId }, { reason: "Testing access control" }),
    c("POST /admin/businesses/:id/suspend", adminBizSuspend.POST, "POST", `/api/admin/businesses/${i.businessId}/suspend`, { id: i.businessId }, { reason: "Testing access control" }),
    c("POST /admin/businesses/:id/reactivate", adminBizReactivate.POST, "POST", `/api/admin/businesses/${i.businessId}/reactivate`, { id: i.businessId }, {}),
    c("GET /admin/audit-logs", adminAudit.GET, "GET", "/api/admin/audit-logs"),
    c("GET /admin/audit-logs/export", adminAuditExport.GET, "GET", "/api/admin/audit-logs/export"),
    c("GET /admin/settings", adminSettings.GET, "GET", "/api/admin/settings"),
    c("PUT /admin/settings", adminSettings.PUT, "PUT", "/api/admin/settings", {}, { values: { platformName: "Hijacked" } }),
    c("GET /admin/support", adminSupport.GET, "GET", "/api/admin/support"),
    c("GET /admin/support/:id", adminTicket.GET, "GET", `/api/admin/support/${i.ticketId}`, { id: i.ticketId }),
    c("PATCH /admin/support/:id", adminTicket.PATCH, "PATCH", `/api/admin/support/${i.ticketId}`, { id: i.ticketId }, { status: "CLOSED" }),
    c("POST /admin/support/:id/reply", adminTicketReply.POST, "POST", `/api/admin/support/${i.ticketId}/reply`, { id: i.ticketId }, { body: "Admin only reply" }),
  ];
}

/** Client routes that refuse admins and anonymous callers. */
function clientCases(i: Ids): Case[] {
  const b = i.businessId;
  return [
    c("GET /client/businesses", clientBusinesses.GET, "GET", "/api/client/businesses"),
    c("POST /client/businesses", clientBusinesses.POST, "POST", "/api/client/businesses", {}, { name: "Sneaky Shop", category: "retail" }),
    c("GET /client/businesses/:id/team", clientTeam.GET, "GET", `/api/client/businesses/${b}/team`, { id: b }),
    c("POST /client/businesses/:id/team", clientTeam.POST, "POST", `/api/client/businesses/${b}/team`, { id: b }, { name: "Sneaky Mgr", email: "sneaky@shop.test" }),
    c("DELETE /client/businesses/:id/team/:userId", clientTeamMember.DELETE, "DELETE", `/api/client/businesses/${b}/team/${i.userId}`, { id: b, userId: i.userId }),
    c("POST /client/businesses/:id/team/:userId", clientTeamMember.POST, "POST", `/api/client/businesses/${b}/team/${i.userId}`, { id: b, userId: i.userId }),
    c("GET /client/support", clientSupport.GET, "GET", "/api/client/support"),
    c("POST /client/support", clientSupport.POST, "POST", "/api/client/support", {}, { subject: "Sneaky ticket", body: "Should never be created" }),
    c("DELETE /client/support/:id", clientTicket.DELETE, "DELETE", `/api/client/support/${i.ticketId}`, { id: i.ticketId }),
  ];
}

/** Business edit routes: owner-only for clients, and an admin may use them too (service allows admin on any business). */
function ownerEditCases(i: Ids): Case[] {
  const b = i.businessId;
  return [
    c("PATCH /client/businesses/:id", clientBusiness.PATCH, "PATCH", `/api/client/businesses/${b}`, { id: b }, { name: "Sneaky Rename", category: "retail" }),
    c("DELETE /client/businesses/:id/logo", clientLogo.DELETE, "DELETE", `/api/client/businesses/${b}/logo`, { id: b }),
  ];
}

/** Client routes that need an authenticated user but a different gate than role. */
function authOnlyCases(i: Ids): Case[] {
  return [
    c("GET /client/businesses/:id", clientBusiness.GET, "GET", `/api/client/businesses/${i.businessId}`, { id: i.businessId }),
    c("GET /client/support/:id", clientTicket.GET, "GET", `/api/client/support/${i.ticketId}`, { id: i.ticketId }),
    c("POST /client/support/:id/reply", clientTicketReply.POST, "POST", `/api/client/support/${i.ticketId}/reply`, { id: i.ticketId }, { body: "Unauthenticated reply" }),
    c("GET /client/profile", clientProfile.GET, "GET", "/api/client/profile"),
    c("PATCH /client/profile", clientProfile.PATCH, "PATCH", "/api/client/profile", {}, { name: "Anon Person" }),
  ];
}

async function setup() {
  const t = await makeClientTenant({ tag: "rbac" });
  const mgr = await makeManager(t);
  const admin = await adminSession();
  const ticket = await db.supportTicket.create({ data: { ticketCode: "TK-RBAC01", clientId: t.client.id, businessId: t.business.id, createdById: t.owner.id, subject: "Seeded ticket" } });
  const ids: Ids = { clientId: t.client.id, businessId: t.business.id, ticketId: ticket.id, userId: mgr.user.id };
  return { t, mgr, admin, ids };
}

const dbFingerprint = async () => ({
  audits: await db.auditLog.count(),
  clients: await db.client.count(),
  businesses: await db.business.count(),
  users: await db.user.count(),
  tickets: await db.supportTicket.count(),
  messages: await db.ticketMessage.count(),
  memberships: await db.businessMembership.count(),
  settings: await db.platformSetting.count(),
  clientStatuses: (await db.client.findMany({ select: { status: true }, orderBy: { id: "asc" } })).map((x) => x.status),
  businessStatuses: (await db.business.findMany({ select: { status: true, name: true }, orderBy: { id: "asc" } })).map((x) => `${x.status}:${x.name}`),
});

async function statuses(cases: Case[], cookie?: string) {
  const out: Record<string, number> = {};
  for (const k of cases) out[k.name] = (await k.run(cookie)).status;
  return out;
}
const allStatus = (cases: Case[], n: number) => Object.fromEntries(cases.map((k) => [k.name, n]));

beforeEach(async () => {
  await resetDb();
});

describe("authentication: every route in the slice refuses a caller without a session", () => {
  it("returns 401 on every admin, client and profile route, and changes nothing", async () => {
    const { ids } = await setup();
    const all = [...adminCases(ids), ...clientCases(ids), ...ownerEditCases(ids), ...authOnlyCases(ids)];
    const before = await dbFingerprint();
    expect(await statuses(all)).toEqual(allStatus(all, 401));
    expect(await dbFingerprint()).toEqual(before);
  });

  it("returns 401 for a garbage or revoked session cookie, with the standard error body", async () => {
    const { ids, t } = await setup();
    const k = clientCases(ids)[0];
    const bad = await k.run(`${cookieName()}=not-a-real-token`);
    expect(bad.status).toBe(401);
    const body = await bad.json();
    expect(body.error.code).toBe("UNAUTHENTICATED");
    expect(JSON.stringify(body)).not.toMatch(/stack|prisma|at \//i);
    await db.session.deleteMany({ where: { userId: t.owner.id } });
    expect((await k.run(t.cookie)).status).toBe(401);
  });
});

describe("role separation", () => {
  it("clients and managers get 403 on every admin route, with no state change", async () => {
    const { ids, t, mgr } = await setup();
    const cases = adminCases(ids);
    const before = await dbFingerprint();
    expect(await statuses(cases, t.cookie)).toEqual(allStatus(cases, 403));
    expect(await statuses(cases, mgr.cookie)).toEqual(allStatus(cases, 403));
    expect(await dbFingerprint()).toEqual(before);
  });

  it("an admin gets 403 on the client-only routes, with no state change", async () => {
    const { ids, admin } = await setup();
    const cases = clientCases(ids);
    const before = await dbFingerprint();
    expect(await statuses(cases, admin.cookie)).toEqual(allStatus(cases, 403));
    expect(await dbFingerprint()).toEqual(before);
  });

  it("an admin may edit a business through the shared edit route, and it is audited under the admin", async () => {
    const { ids, admin, t } = await setup();
    const res = await clientBusiness.PATCH(req("PATCH", `/api/client/businesses/${ids.businessId}`, { cookie: admin.cookie, body: { name: "Admin Renamed", category: "retail" } }), seg({ id: ids.businessId }));
    expect(res.status).toBe(200);
    const row = await db.auditLog.findFirst({ where: { entityId: ids.businessId, actorRole: "SUPER_ADMIN" }, orderBy: { createdAt: "desc" } });
    expect(row?.actorEmail).toBe(admin.admin.email);
    expect(row?.clientId).toBe(t.client.id);
  });

  it("the owner can use the client routes the manager is barred from", async () => {
    const { ids, t } = await setup();
    const own = clientCases(ids);
    const get = async (n: string) => (await own.find((k) => k.name === n)!.run(t.cookie)).status;
    expect(await get("GET /client/businesses")).toBe(200);
    expect(await get("GET /client/businesses/:id/team")).toBe(200);
    expect(await get("GET /client/support")).toBe(200);
  });
});

describe("owner-only operations and permissions", () => {
  it("a manager gets 403 on business edit, logo, team and business creation, and 200 on what a manager may do", async () => {
    const { ids, mgr, t } = await setup();
    const cases = [...clientCases(ids), ...ownerEditCases(ids)];
    const owner = new Set([
      "POST /client/businesses",
      "PATCH /client/businesses/:id",
      "DELETE /client/businesses/:id/logo",
      "GET /client/businesses/:id/team",
      "POST /client/businesses/:id/team",
      "DELETE /client/businesses/:id/team/:userId",
      "POST /client/businesses/:id/team/:userId",
    ]);
    const before = await dbFingerprint();
    for (const k of cases.filter((x) => owner.has(x.name))) expect((await k.run(mgr.cookie)).status, k.name).toBe(403);
    const upload = new FormData();
    upload.set("file", fileOf(PNG_BYTES(), "logo.png"));
    expect((await clientLogo.POST(req("POST", `/api/client/businesses/${ids.businessId}/logo`, { cookie: mgr.cookie, form: upload }), seg({ id: ids.businessId }))).status).toBe(403);
    expect(await dbFingerprint()).toEqual(before);
    // the same manager keeps read access and support access
    expect((await cases.find((k) => k.name === "GET /client/businesses")!.run(mgr.cookie)).status).toBe(200);
    expect((await cases.find((k) => k.name === "GET /client/support")!.run(mgr.cookie)).status).toBe(200);
    expect((await clientBusiness.GET(req("GET", `/api/client/businesses/${ids.businessId}`, { cookie: mgr.cookie }), seg({ id: ids.businessId }))).status).toBe(200);
    expect(t.owner.id).not.toBe(mgr.user.id);
  });

  it("a client whose account lacks a permission gets 403 for that feature only", async () => {
    const limited = await makeClientTenant({ tag: "lim", permissions: ["qr.manage"] });
    const ticket = await db.supportTicket.create({ data: { ticketCode: "TK-LIM001", clientId: limited.client.id, createdById: limited.owner.id, subject: "Seeded ticket" } });
    const ids: Ids = { clientId: limited.client.id, businessId: limited.business.id, ticketId: ticket.id, userId: limited.owner.id };
    const k = (n: string) => [...clientCases(ids), ...ownerEditCases(ids), ...authOnlyCases(ids)].find((x) => x.name === n)!;
    expect((await k("GET /client/support").run(limited.cookie)).status).toBe(403);
    expect((await k("POST /client/support").run(limited.cookie)).status).toBe(403);
    expect((await k("GET /client/support/:id").run(limited.cookie)).status).toBe(403);
    expect((await k("POST /client/support/:id/reply").run(limited.cookie)).status).toBe(403);
    expect((await k("PATCH /client/businesses/:id").run(limited.cookie)).status).toBe(403);
    expect((await k("GET /client/businesses/:id/team").run(limited.cookie)).status).toBe(403);
    expect((await k("GET /client/profile").run(limited.cookie)).status).toBe(200);
  });
});

describe("cross-site protection on state changes", () => {
  it("blocks cross-origin mutations for every role and leaves data untouched", async () => {
    const { ids, t, admin } = await setup();
    const before = await dbFingerprint();
    const hostile = [
      { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      { origin: "https://evil.example", "sec-fetch-site": "" },
      { origin: "http://localhost:3000", "sec-fetch-site": "same-site" },
    ];
    const mutating = (cs: Case[]) => cs.filter((k) => !k.name.startsWith("GET "));
    for (const h of hostile) {
      for (const k of mutating(adminCases(ids))) {
        const res = await k.run(admin.cookie, h);
        expect(res.status, `${k.name} ${JSON.stringify(h)}`).toBe(403);
        expect((await res.json()).error.message).toBe("Cross-site request blocked");
      }
      for (const k of mutating(clientCases(ids))) expect((await k.run(t.cookie, h)).status, `${k.name} ${JSON.stringify(h)}`).toBe(403);
    }
    expect(await dbFingerprint()).toEqual(before);
  });

  it("allows a same-origin mutation", async () => {
    const { admin } = await setup();
    const res = await adminSettings.PUT(req("PUT", "/api/admin/settings", { cookie: admin.cookie, body: { values: { platformName: "Fine Name" } } }), seg({}));
    expect(res.status).toBe(200);
  });
});

describe("responses through the route layer", () => {
  it("wraps data as { data } and bad input as 422 VALIDATION with field details", async () => {
    const { admin } = await setup();
    const ok = await adminSettings.GET(req("GET", "/api/admin/settings", { cookie: admin.cookie }), seg({}));
    expect(ok.status).toBe(200);
    expect((await ok.json()).data.orderExpiryMinutes).toBe(30);
    const bad = await adminSettings.PUT(req("PUT", "/api/admin/settings", { cookie: admin.cookie, body: { values: { orderExpiryMinutes: 2 } } }), seg({}));
    expect(bad.status).toBe(422);
    const body = await bad.json();
    expect(body.error.code).toBe("VALIDATION");
    expect(body.error.details.fields.orderExpiryMinutes).toBeTruthy();
    expect(await db.platformSetting.count()).toBe(0);
  });

  it("maps malformed JSON to 400, unknown ids to 404, and a duplicate to 409", async () => {
    const { admin, t } = await setup();
    const raw = new Request("http://localhost:3000/api/admin/clients", {
      method: "POST",
      headers: { host: "localhost:3000", origin: "http://localhost:3000", "sec-fetch-site": "same-origin", cookie: admin.cookie, "content-type": "application/json" },
      body: "{not json",
    });
    const { NextRequest: NR } = await import("next/server");
    const res = await adminClients.POST(new NR(raw), seg({}));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("BAD_REQUEST");
    expect((await adminClient.GET(req("GET", "/api/admin/clients/nope", { cookie: admin.cookie }), seg({ id: "nope" }))).status).toBe(404);
    const dup = await adminClients.POST(req("POST", "/api/admin/clients", { cookie: admin.cookie, body: { name: "Dup Co", contactName: "Dup Dup", email: t.owner.email } }), seg({}));
    expect(dup.status).toBe(409);
  });

  it("turns an unhandled ZodError from a service into a 422 rather than a 500", async () => {
    const { t } = await setup();
    const longId = "u".repeat(65);
    const res = await clientTeamMember.DELETE(req("DELETE", `/api/client/businesses/${t.business.id}/team/${longId}`, { cookie: t.cookie }), seg({ id: t.business.id, userId: longId }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION");
  });

  it("a client suspended through the admin route is signed out on their very next request", async () => {
    const { admin, t } = await setup();
    expect((await clientBusinesses.GET(req("GET", "/api/client/businesses", { cookie: t.cookie }), seg({}))).status).toBe(200);
    const s = await adminClientSuspend.POST(req("POST", `/api/admin/clients/${t.client.id}/suspend`, { cookie: admin.cookie, body: { reason: "Chargebacks under review" } }), seg({ id: t.client.id }));
    expect(s.status).toBe(200);
    expect((await clientBusinesses.GET(req("GET", "/api/client/businesses", { cookie: t.cookie }), seg({}))).status).toBe(401);
  });
});

describe("happy paths through the route handlers", () => {
  it("admin client lifecycle: create, list, read, update, permissions, reset, activity", async () => {
    const { admin } = await setup();
    const created = await adminClients.POST(req("POST", "/api/admin/clients", { cookie: admin.cookie, body: { name: "Route Traders", contactName: "Rita Route", email: "rita@route.test", maxBusinesses: 2 } }), seg({}));
    expect(created.status).toBe(200);
    const { data } = await created.json();
    expect(data.inviteLink).toContain("/auth/");
    const id = data.client.id as string;
    const list = await (await adminClients.GET(req("GET", "/api/admin/clients?q=route", { cookie: admin.cookie }), seg({}))).json();
    expect(list.data.items.map((x: { id: string }) => x.id)).toContain(id);
    expect((await adminClient.GET(req("GET", `/api/admin/clients/${id}`, { cookie: admin.cookie }), seg({ id }))).status).toBe(200);
    expect((await adminClient.PATCH(req("PATCH", `/api/admin/clients/${id}`, { cookie: admin.cookie, body: { name: "Route Traders Ltd", contactName: "Rita Route", maxBusinesses: 3 } }), seg({ id }))).status).toBe(200);
    expect((await adminClientPerms.PUT(req("PUT", `/api/admin/clients/${id}/permissions`, { cookie: admin.cookie, body: { permissions: ["support.use"] } }), seg({ id }))).status).toBe(200);
    expect((await adminClientPerms.PUT(req("PUT", `/api/admin/clients/${id}/permissions`, { cookie: admin.cookie, body: { permissions: ["made.up"] } }), seg({ id }))).status).toBe(422);
    expect((await adminClientReset.POST(req("POST", `/api/admin/clients/${id}/reset-password`, { cookie: admin.cookie, body: {} }), seg({ id }))).status).toBe(200);
    expect((await adminClientActivity.GET(req("GET", `/api/admin/clients/${id}/login-activity`, { cookie: admin.cookie }), seg({ id }))).status).toBe(200);
    expect((await adminClientSuspend.POST(req("POST", `/api/admin/clients/${id}/suspend`, { cookie: admin.cookie, body: {} }), seg({ id }))).status).toBe(422);
    expect((await adminClientSuspend.POST(req("POST", `/api/admin/clients/${id}/suspend`, { cookie: admin.cookie, body: { reason: "Manual review" } }), seg({ id }))).status).toBe(200);
    expect((await adminClientReactivate.POST(req("POST", `/api/admin/clients/${id}/reactivate`, { cookie: admin.cookie, body: {} }), seg({ id }))).status).toBe(200);
  });

  it("business lifecycle: client creates and edits, admin approves, logo upload and removal", async () => {
    const { admin, t } = await setup();
    const created = await clientBusinesses.POST(req("POST", "/api/client/businesses", { cookie: t.cookie, body: { name: "Route Cafe", category: "food" } }), seg({}));
    expect(created.status).toBe(200);
    const id = (await created.json()).data.id as string;
    // memberships are read per request, so the new business is usable immediately
    const edit = await clientBusiness.PATCH(req("PATCH", `/api/client/businesses/${id}`, { cookie: t.cookie, body: { name: "Route Cafe 2", category: "food", city: "Pune" } }), seg({ id }));
    expect(edit.status).toBe(200);
    expect((await clientBusiness.PATCH(req("PATCH", `/api/client/businesses/${id}`, { cookie: t.cookie, body: { name: "Route Cafe 2", category: "food", pincode: "99" } }), seg({ id }))).status).toBe(422);

    expect((await adminBizApprove.POST(req("POST", `/api/admin/businesses/${id}/approve`, { cookie: admin.cookie, body: {} }), seg({ id }))).status).toBe(200);
    expect((await adminBizApprove.POST(req("POST", `/api/admin/businesses/${id}/approve`, { cookie: admin.cookie, body: {} }), seg({ id }))).status).toBe(400);
    expect((await adminBizSuspend.POST(req("POST", `/api/admin/businesses/${id}/suspend`, { cookie: admin.cookie, body: {} }), seg({ id }))).status).toBe(422);
    expect((await adminBizSuspend.POST(req("POST", `/api/admin/businesses/${id}/suspend`, { cookie: admin.cookie, body: { reason: "Review needed" } }), seg({ id }))).status).toBe(200);
    expect((await adminBizReactivate.POST(req("POST", `/api/admin/businesses/${id}/reactivate`, { cookie: admin.cookie, body: {} }), seg({ id }))).status).toBe(200);
    expect((await adminBusinesses.GET(req("GET", "/api/admin/businesses?status=ACTIVE", { cookie: admin.cookie }), seg({}))).status).toBe(200);
    expect((await adminBusiness.GET(req("GET", `/api/admin/businesses/${id}`, { cookie: admin.cookie }), seg({ id }))).status).toBe(200);

    const up = new FormData();
    up.set("file", fileOf(PNG_BYTES(), "logo.png"));
    expect((await clientLogo.POST(req("POST", `/api/client/businesses/${id}/logo`, { cookie: t.cookie, form: up }), seg({ id }))).status).toBe(200);
    const fake = new FormData();
    fake.set("file", fileOf(Buffer.from("<html></html>"), "logo.png"));
    expect((await clientLogo.POST(req("POST", `/api/client/businesses/${id}/logo`, { cookie: t.cookie, form: fake }), seg({ id }))).status).toBe(422);
    expect((await clientLogo.POST(req("POST", `/api/client/businesses/${id}/logo`, { cookie: t.cookie, body: { file: "x" } }), seg({ id }))).status).toBe(400);
    const nofile = new FormData();
    nofile.set("other", "x");
    expect((await clientLogo.POST(req("POST", `/api/client/businesses/${id}/logo`, { cookie: t.cookie, form: nofile }), seg({ id }))).status).toBe(400);
    expect((await clientLogo.DELETE(req("DELETE", `/api/client/businesses/${id}/logo`, { cookie: t.cookie }), seg({ id }))).status).toBe(200);
    expect(await db.fileAsset.count()).toBe(0);
  });

  it("team management through routes: add, list, resend, remove", async () => {
    const { t } = await setup();
    const add = await clientTeam.POST(req("POST", `/api/client/businesses/${t.business.id}/team`, { cookie: t.cookie, body: { name: "Route Mgr", email: "routemgr@shop.test" } }), seg({ id: t.business.id }));
    expect(add.status).toBe(200);
    const uid = (await add.json()).data.member.id as string;
    const list = await (await clientTeam.GET(req("GET", `/api/client/businesses/${t.business.id}/team`, { cookie: t.cookie }), seg({ id: t.business.id }))).json();
    expect(list.data.map((m: { email: string }) => m.email)).toContain("routemgr@shop.test");
    expect((await clientTeamMember.POST(req("POST", `/api/client/businesses/${t.business.id}/team/${uid}`, { cookie: t.cookie }), seg({ id: t.business.id, userId: uid }))).status).toBe(200);
    expect((await clientTeamMember.DELETE(req("DELETE", `/api/client/businesses/${t.business.id}/team/${uid}`, { cookie: t.cookie }), seg({ id: t.business.id, userId: uid }))).status).toBe(200);
    expect((await clientTeamMember.DELETE(req("DELETE", `/api/client/businesses/${t.business.id}/team/${uid}`, { cookie: t.cookie }), seg({ id: t.business.id, userId: uid }))).status).toBe(404);
    expect((await clientTeam.POST(req("POST", `/api/client/businesses/${t.business.id}/team`, { cookie: t.cookie, body: { name: "x", email: "bad" } }), seg({ id: t.business.id }))).status).toBe(422);
  });

  it("support conversation through routes: client opens, admin works it, client reopens and closes", async () => {
    const { t, admin } = await setup();
    const created = await clientSupport.POST(req("POST", "/api/client/support", { cookie: t.cookie, body: { subject: "Route ticket", body: "Opening via the route." } }), seg({}));
    expect(created.status).toBe(200);
    const id = (await created.json()).data.id as string;
    expect((await clientSupport.POST(req("POST", "/api/client/support", { cookie: t.cookie, body: { subject: "x", body: "y" } }), seg({}))).status).toBe(422);
    expect((await adminSupport.GET(req("GET", "/api/admin/support?status=OPEN", { cookie: admin.cookie }), seg({}))).status).toBe(200);
    expect((await adminTicketReply.POST(req("POST", `/api/admin/support/${id}/reply`, { cookie: admin.cookie, body: { body: "Looking now." } }), seg({ id }))).status).toBe(200);
    const patched = await adminTicket.PATCH(req("PATCH", `/api/admin/support/${id}`, { cookie: admin.cookie, body: { status: "RESOLVED", priority: "HIGH" } }), seg({ id }));
    expect(patched.status).toBe(200);
    expect((await patched.json()).data).toMatchObject({ status: "RESOLVED", priority: "HIGH" });
    expect((await adminTicket.PATCH(req("PATCH", `/api/admin/support/${id}`, { cookie: admin.cookie, body: { status: "WRONG" } }), seg({ id }))).status).toBe(422);
    expect((await clientTicketReply.POST(req("POST", `/api/client/support/${id}/reply`, { cookie: t.cookie, body: { body: "Still broken." } }), seg({ id }))).status).toBe(200);
    expect((await (await clientTicket.GET(req("GET", `/api/client/support/${id}`, { cookie: t.cookie }), seg({ id }))).json()).data.status).toBe("OPEN");
    expect((await clientTicket.DELETE(req("DELETE", `/api/client/support/${id}`, { cookie: t.cookie }), seg({ id }))).status).toBe(200);
    expect((await clientTicketReply.POST(req("POST", `/api/client/support/${id}/reply`, { cookie: t.cookie, body: { body: "After close" } }), seg({ id }))).status).toBe(400);
  });

  it("profile works for client and admin alike, rejects bad input, and cannot change the email", async () => {
    const { t, admin } = await setup();
    for (const who of [t, admin]) {
      const patch = await clientProfile.PATCH(req("PATCH", "/api/client/profile", { cookie: who.cookie, body: { name: "New Name", phone: "+91 98765 43210", email: "taken@evil.test" } }), seg({}));
      expect(patch.status).toBe(200);
      const got = await (await clientProfile.GET(req("GET", "/api/client/profile", { cookie: who.cookie }), seg({}))).json();
      expect(got.data.user.name).toBe("New Name");
      expect(got.data.user.email).not.toBe("taken@evil.test");
      expect(JSON.stringify(got)).not.toMatch(/passwordHash|totpSecret/);
      expect((await clientProfile.PATCH(req("PATCH", "/api/client/profile", { cookie: who.cookie, body: { name: "" } }), seg({}))).status).toBe(422);
    }
  });

  it("audit-log listing and CSV export are admin-only, with the right headers", async () => {
    const { admin, t } = await setup();
    await adminSettings.PUT(req("PUT", "/api/admin/settings", { cookie: admin.cookie, body: { values: { platformName: "Export Name" } } }), seg({}));
    const list = await (await adminAudit.GET(req("GET", "/api/admin/audit-logs?action=settings", { cookie: admin.cookie }), seg({}))).json();
    expect(list.data.total).toBe(1);
    const csv = await adminAuditExport.GET(req("GET", "/api/admin/audit-logs/export?action=settings", { cookie: admin.cookie }), seg({}));
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.headers.get("content-disposition")).toMatch(/^attachment; filename="audit-log-.*\.csv"$/);
    const text = await csv.text();
    expect(text.split("\r\n")[0]).toBe("time,actor_email,actor_role,action,entity_type,entity_id,client_id,ip,metadata");
    expect(text).toContain("settings.update");
    const denied = await adminAuditExport.GET(req("GET", "/api/admin/audit-logs/export", { cookie: t.cookie }), seg({}));
    expect(denied.status).toBe(403);
    expect(denied.headers.get("content-type")).toContain("application/json");
    expect(await denied.text()).not.toContain("time,actor_email");
  });
});

// Keep the type import used for readers of this file.
export type { Tenant };
