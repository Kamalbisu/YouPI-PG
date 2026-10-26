import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import * as adminClient from "@/app/api/admin/clients/[id]/route";
import * as clientBusinesses from "@/app/api/client/businesses/route";
import * as clientBusiness from "@/app/api/client/businesses/[id]/route";
import * as clientLogo from "@/app/api/client/businesses/[id]/logo/route";
import * as clientTeam from "@/app/api/client/businesses/[id]/team/route";
import * as clientTeamMember from "@/app/api/client/businesses/[id]/team/[userId]/route";
import * as clientSupport from "@/app/api/client/support/route";
import * as clientTicket from "@/app/api/client/support/[id]/route";
import * as clientTicketReply from "@/app/api/client/support/[id]/reply/route";
import { AUDIT_CSV_HEADER, auditCsvStream, csvCell } from "@/server/services/audit-logs";
import { addTeamMember, listTeam, removeTeamMember, resendTeamInvite } from "@/server/services/team";
import { getBusiness, listMyBusinesses, removeBusinessLogo, setBusinessLogo, updateBusiness } from "@/server/services/businesses";
import { createTicket, getTicket, listMyTickets, replyToTicket } from "@/server/services/support";
import { createClient } from "@/server/services/clients";
import { resetDb } from "./helpers";
import { addOwnedBusiness, adminSession, expectAppError, fileOf, makeClientTenant, makeManager, PNG_BYTES, req, seg, tokenFromLink } from "./helpers-admin";

beforeEach(async () => {
  await resetDb();
});

async function twoTenants() {
  const a = await makeClientTenant({ tag: "alpha" });
  const b = await makeClientTenant({ tag: "bravo" });
  const bTicket = await createTicket(b.ctx, { subject: "Bravo private ticket", body: "Bravo secret problem text" });
  const bMgr = await makeManager(b);
  return { a, b, bTicket, bMgr };
}

describe("cross-tenant access at the service layer: out-of-tenant ids behave like missing ones (404)", () => {
  it("client A cannot read, edit or change the logo of client B's business", async () => {
    const { a, b } = await twoTenants();
    await expectAppError(getBusiness(a.ctx, b.business.id), "NOT_FOUND");
    await expectAppError(updateBusiness(a.ctx, b.business.id, { name: "Hijacked", category: "retail" }), "NOT_FOUND");
    await expectAppError(setBusinessLogo(a.ctx, b.business.id, fileOf(PNG_BYTES(), "x.png")), "NOT_FOUND");
    await expectAppError(removeBusinessLogo(a.ctx, b.business.id), "NOT_FOUND");
    const after = await db.business.findUnique({ where: { id: b.business.id } });
    expect(after?.name).toBe(b.business.name);
    expect(after?.logoFileId).toBeNull();
    expect(await db.fileAsset.count()).toBe(0);
  });

  it("a nonexistent id and another tenant's id are indistinguishable", async () => {
    const { a, b } = await twoTenants();
    const missing = await expectAppError(getBusiness(a.ctx, "does-not-exist"), "NOT_FOUND");
    const foreign = await expectAppError(getBusiness(a.ctx, b.business.id), "NOT_FOUND");
    expect(foreign.message).toBe(missing.message);
    expect(foreign.status).toBe(missing.status);
    expect(JSON.stringify(foreign)).not.toContain(b.business.name);
  });

  it("client A cannot list, add, resend or remove team members of client B's business", async () => {
    const { a, b, bMgr } = await twoTenants();
    await expectAppError(listTeam(a.ctx, b.business.id), "NOT_FOUND");
    await expectAppError(addTeamMember(a.ctx, b.business.id, { name: "Infiltrator", email: "inf@evil.test" }), "NOT_FOUND");
    await expectAppError(resendTeamInvite(a.ctx, b.business.id, bMgr.user.id), "NOT_FOUND");
    await expectAppError(removeTeamMember(a.ctx, b.business.id, bMgr.user.id), "NOT_FOUND");
    expect(await db.user.findUnique({ where: { email: "inf@evil.test" } })).toBeNull();
    expect(await db.businessMembership.count({ where: { userId: bMgr.user.id } })).toBe(1);
  });

  it("client A cannot name B's own business or user ids to reach B's team through A's business", async () => {
    const { a, bMgr } = await twoTenants();
    // A's own business, but the userId belongs to a B manager: not a member there, so 404 and B's membership survives
    await expectAppError(removeTeamMember(a.ctx, a.business.id, bMgr.user.id), "NOT_FOUND");
    await expectAppError(resendTeamInvite(a.ctx, a.business.id, bMgr.user.id), "NOT_FOUND");
    expect(await db.businessMembership.count({ where: { userId: bMgr.user.id } })).toBe(1);
  });

  it("the business list only ever contains the caller's own businesses", async () => {
    const { a, b } = await twoTenants();
    const mine = await listMyBusinesses(a.ctx);
    const ids = JSON.stringify(mine);
    expect(ids).toContain(a.business.id);
    expect(ids).not.toContain(b.business.id);
    expect(ids).not.toContain(b.business.name);
  });

  it("client A cannot read or reply to B's ticket, and A's list never contains it", async () => {
    const { a, b, bTicket } = await twoTenants();
    await expectAppError(getTicket(a.ctx, bTicket.id), "NOT_FOUND");
    await expectAppError(replyToTicket(a.ctx, bTicket.id, { body: "Intruder reply" }), "NOT_FOUND");
    expect(await db.ticketMessage.count({ where: { ticketId: bTicket.id } })).toBe(1);
    const aTicket = await createTicket(a.ctx, { subject: "Alpha ticket", body: "Alpha text" });
    const list = await listMyTickets(a.ctx, {});
    expect(list.items.map((x: { id: string }) => x.id)).toEqual([aTicket.id]);
    expect(JSON.stringify(list)).not.toContain("Bravo");
    expect(b.client.id).not.toBe(a.client.id);
  });

  it("a ticket cannot be attached to another tenant's business", async () => {
    const { a, b } = await twoTenants();
    await expectAppError(createTicket(a.ctx, { subject: "Pointing at bravo", body: "Hello there", businessId: b.business.id }), "NOT_FOUND");
    expect(await db.supportTicket.count({ where: { clientId: a.client.id } })).toBe(0);
  });

  it("a manager sees only their own business and tickets, not siblings in the same client", async () => {
    const a = await makeClientTenant({ tag: "multi" });
    const second = await addOwnedBusiness(a, "Second Outlet");
    const mgr = await makeManager(a, a.business.id);
    await expectAppError(getBusiness(mgr.ctx, second.id), "NOT_FOUND");
    const mine = JSON.stringify(await listMyBusinesses(mgr.ctx));
    expect(mine).toContain(a.business.id);
    expect(mine).not.toContain(second.id);
    const secondTicket = await createTicket(a.ctx, { subject: "Second outlet issue", body: "Only for owner view", businessId: second.id });
    await expectAppError(getTicket(mgr.ctx, secondTicket.id), "NOT_FOUND");
    await expectAppError(createTicket(mgr.ctx, { subject: "Wrong outlet", body: "Not mine to file", businessId: second.id }), "NOT_FOUND");
    const own = await createTicket(a.ctx, { subject: "First outlet issue", body: "Visible to its manager", businessId: a.business.id });
    expect((await getTicket(mgr.ctx, own.id)).id).toBe(own.id);
  });

  it("a removed manager loses access to the business and ticket at once", async () => {
    const a = await makeClientTenant({ tag: "rm" });
    const mgr = await makeManager(a);
    const t = await createTicket(a.ctx, { subject: "Business ticket", body: "Visible to manager", businessId: a.business.id });
    expect((await getTicket(mgr.ctx, t.id)).id).toBe(t.id);
    await removeTeamMember(a.ctx, a.business.id, mgr.user.id);
    // the manager's only membership is gone, so their existing session no longer authenticates
    const res = await clientBusiness.GET(req("GET", `/api/client/businesses/${a.business.id}`, { cookie: mgr.cookie }), seg({ id: a.business.id }));
    expect(res.status).toBe(401);
    const tk = await clientTicket.GET(req("GET", `/api/client/support/${t.id}`, { cookie: mgr.cookie }), seg({ id: t.id }));
    expect(tk.status).toBe(401);
  });
});

describe("cross-tenant access through route handlers", () => {
  it("A gets 404 on every B-addressed business, logo, team and ticket route and nothing changes", async () => {
    const { a, b, bTicket, bMgr } = await twoTenants();
    const bid = b.business.id;
    const upload = new FormData();
    upload.set("file", fileOf(PNG_BYTES(), "logo.png"));
    const results: Record<string, number> = {
      "GET business": (await clientBusiness.GET(req("GET", `/api/client/businesses/${bid}`, { cookie: a.cookie }), seg({ id: bid }))).status,
      "PATCH business": (await clientBusiness.PATCH(req("PATCH", `/api/client/businesses/${bid}`, { cookie: a.cookie, body: { name: "Hijack", category: "retail" } }), seg({ id: bid }))).status,
      "POST logo": (await clientLogo.POST(req("POST", `/api/client/businesses/${bid}/logo`, { cookie: a.cookie, form: upload }), seg({ id: bid }))).status,
      "DELETE logo": (await clientLogo.DELETE(req("DELETE", `/api/client/businesses/${bid}/logo`, { cookie: a.cookie }), seg({ id: bid }))).status,
      "GET team": (await clientTeam.GET(req("GET", `/api/client/businesses/${bid}/team`, { cookie: a.cookie }), seg({ id: bid }))).status,
      "POST team": (await clientTeam.POST(req("POST", `/api/client/businesses/${bid}/team`, { cookie: a.cookie, body: { name: "Inf", email: "inf2@evil.test" } }), seg({ id: bid }))).status,
      "DELETE member": (await clientTeamMember.DELETE(req("DELETE", `/api/client/businesses/${bid}/team/${bMgr.user.id}`, { cookie: a.cookie }), seg({ id: bid, userId: bMgr.user.id }))).status,
      "POST resend": (await clientTeamMember.POST(req("POST", `/api/client/businesses/${bid}/team/${bMgr.user.id}`, { cookie: a.cookie }), seg({ id: bid, userId: bMgr.user.id }))).status,
      "GET ticket": (await clientTicket.GET(req("GET", `/api/client/support/${bTicket.id}`, { cookie: a.cookie }), seg({ id: bTicket.id }))).status,
      "DELETE ticket": (await clientTicket.DELETE(req("DELETE", `/api/client/support/${bTicket.id}`, { cookie: a.cookie }), seg({ id: bTicket.id }))).status,
      "POST reply": (await clientTicketReply.POST(req("POST", `/api/client/support/${bTicket.id}/reply`, { cookie: a.cookie, body: { body: "Intruder" } }), seg({ id: bTicket.id }))).status,
      "POST ticket for B business": (await clientSupport.POST(req("POST", "/api/client/support", { cookie: a.cookie, body: { subject: "Pointing at B", body: "Hello there", businessId: bid } }), seg({}))).status,
    };
    for (const [name, status] of Object.entries(results)) expect(status, name).toBe(404);
    const biz = await db.business.findUnique({ where: { id: bid } });
    expect(biz?.name).toBe(b.business.name);
    expect(biz?.logoFileId).toBeNull();
    expect((await db.supportTicket.findUnique({ where: { id: bTicket.id } }))?.status).toBe("OPEN");
    expect(await db.ticketMessage.count({ where: { ticketId: bTicket.id } })).toBe(1);
    expect(await db.user.findUnique({ where: { email: "inf2@evil.test" } })).toBeNull();
    expect(await db.businessMembership.count({ where: { userId: bMgr.user.id } })).toBe(1);
  });

  it("list routes leak nothing about the other tenant", async () => {
    const { a, b } = await twoTenants();
    const bizList = await (await clientBusinesses.GET(req("GET", "/api/client/businesses", { cookie: a.cookie }), seg({}))).text();
    expect(bizList).toContain(a.business.id);
    expect(bizList).not.toContain(b.business.id);
    expect(bizList).not.toContain(b.client.id);
    const tickets = await (await clientSupport.GET(req("GET", "/api/client/support?q=Bravo", { cookie: a.cookie }), seg({}))).text();
    expect(tickets).not.toContain("Bravo");
  });

  it("the admin client route is not reachable by a client with their own id either", async () => {
    const { a } = await twoTenants();
    const res = await adminClient.GET(req("GET", `/api/admin/clients/${a.client.id}`, { cookie: a.cookie }), seg({ id: a.client.id }));
    expect(res.status).toBe(403);
  });
});

describe("audit CSV export: spreadsheet formula injection", () => {
  const dangerous = ["=SUM(A1)", "+1+1", "-2+3", "@cmd", "\tTABBED", "\rCR", "=HYPERLINK(\"http://evil\")"];

  it("csvCell neutralises every formula trigger and quotes per RFC 4180", () => {
    for (const v of dangerous) {
      const out = csvCell(v);
      const unquoted = out.startsWith('"') ? out.slice(1, -1).replace(/""/g, '"') : out;
      expect(unquoted.startsWith("'"), JSON.stringify(v)).toBe(true);
      expect(/^[=+\-@\t\r]/.test(unquoted), JSON.stringify(v)).toBe(false);
    }
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(42)).toBe("42");
    expect(csvCell(new Date("2026-01-02T03:04:05.000Z"))).toBe("2026-01-02T03:04:05.000Z");
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });

  /** Minimal RFC 4180 reader, enough to prove that the output round-trips. */
  function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = "";
    let inQ = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') inQ = false;
        else cell += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ",") { row.push(cell); cell = ""; }
      else if (ch === "\r" && text[i + 1] === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; }
      else cell += ch;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  async function readAll(stream: ReadableStream<Uint8Array>) {
    return new Response(stream).text();
  }

  it("an exported stream puts the header first, keeps hostile cells inert and round-trips the row count", async () => {
    const { admin, ctx } = await adminSession();
    for (const [i, v] of dangerous.entries()) {
      await db.auditLog.create({
        data: { actorEmail: `${v}@evil.test`, actorRole: "CLIENT", action: `test.inject${i}`, entityType: v, entityId: `id,${i}`, ip: "203.0.113.5", userAgent: v, metadata: { note: v, nested: { text: `x\n${v}` } } },
      });
    }
    const text = await readAll(auditCsvStream(ctx, {}));
    const rows = parseCsv(text);
    expect(rows[0]).toEqual(AUDIT_CSV_HEADER);
    const body = rows.slice(1).filter((r) => r.length > 1);
    expect(body.length).toBe(dangerous.length);
    for (const r of body) {
      expect(r.length).toBe(AUDIT_CSV_HEADER.length);
      for (const cell of r) expect(/^[=+\-@\t\r]/.test(cell), JSON.stringify(cell)).toBe(false);
    }
    expect(admin.email).toBe("admin@example.com");
  });

  it("filters apply to the export, and an out-of-range filter value does not widen it", async () => {
    const { ctx } = await adminSession();
    await db.auditLog.createMany({ data: [
      { actorRole: "SYSTEM", action: "keep.me", entityType: "X" },
      { actorRole: "SYSTEM", action: "drop.me", entityType: "X" },
    ] });
    const rows = parseCsv(await readAll(auditCsvStream(ctx, { action: "keep.me" }))).filter((r) => r.length > 1);
    expect(rows.slice(1).map((r) => r[3])).toEqual(["keep.me"]);
  });

  it("a non-admin gets 403 synchronously, before any stream exists", async () => {
    const { a } = await twoTenants();
    await db.auditLog.create({ data: { actorRole: "SYSTEM", action: "secret.event", entityType: "X" } });
    expect(() => auditCsvStream(a.ctx, {})).toThrow(/forbidden|permission|admin/i);
  });
});

describe("audit trail never stores secrets", () => {
  it("audit() redacts secret-looking keys at any depth and truncates oversized values", async () => {
    const { ctx } = await adminSession();
    await audit(ctx, {
      action: "test.redact",
      entityType: "X",
      metadata: {
        password: "hunter2",
        newPassword: "hunter3",
        apiKey: "k-123",
        nested: { sessionToken: "tok-abc", authorization: "Bearer zzz", cookie: "sid=1", safe: "kept", deeper: { otpCode: "123456", totpSecret: "BASE32" } },
        list: [{ secret: "s1", ok: 1 }],
        long: "x".repeat(2000),
        safe: "visible",
      },
    });
    const row = await db.auditLog.findFirstOrThrow({ where: { action: "test.redact" } });
    const json = JSON.stringify(row.metadata);
    for (const leaked of ["hunter2", "hunter3", "k-123", "tok-abc", "Bearer zzz", "sid=1", "123456", "BASE32", "s1"]) expect(json, leaked).not.toContain(leaked);
    const m = row.metadata as { password: string; safe: string; nested: { safe: string }; long: string; list: Array<{ secret: string; ok: number }> };
    expect(m.password).toBe("[redacted]");
    expect(m.safe).toBe("visible");
    expect(m.nested.safe).toBe("kept");
    expect(m.list[0]).toEqual({ secret: "[redacted]", ok: 1 });
    expect(m.long.length).toBeLessThan(600);
  });

  it("invite and reset tokens issued by real flows do not appear in any audit row", async () => {
    const { ctx } = await adminSession();
    const created = await createClient(ctx, { name: "Audit Leak Co", contactName: "Leak Tester", email: "leak@co.test", maxBusinesses: 1 });
    const token = tokenFromLink(created.inviteLink);
    const t = await makeClientTenant({ tag: "leak" });
    const added = await addTeamMember(t.ctx, t.business.id, { name: "Leak Mgr", email: "leakmgr@co.test" });
    const token2 = tokenFromLink(added.inviteLink);
    const dump = JSON.stringify(await db.auditLog.findMany());
    expect(dump.length).toBeGreaterThan(10);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(token2);
    expect(dump).not.toMatch(/passwordHash|\$argon2|\$2[aby]\$/);
  });
});
