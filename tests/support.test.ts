import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  closeMyTicket,
  createTicket,
  getTicket,
  listAllTickets,
  listMyTickets,
  replyToTicket,
  setTicketPriority,
  setTicketStatus,
} from "@/server/services/support";
import { anonCtx, resetDb } from "./helpers";
import { adminSession, expectAppError, makeClientTenant, makeManager } from "./helpers-admin";

const TICKET = { subject: "Payout is delayed", body: "My settlement has not arrived for two days." };

beforeEach(async () => {
  await resetDb();
});

describe("ticket creation", () => {
  it("creates an OPEN ticket with the first message, a code, an audit entry, and tells admins", async () => {
    const admin = await adminSession();
    const t = await makeClientTenant();
    const tk = await createTicket(t.ctx, { ...TICKET, businessId: t.business.id });
    expect(tk).toMatchObject({ status: "OPEN", priority: "NORMAL", clientId: t.client.id, businessId: t.business.id, createdById: t.owner.id });
    expect(tk.ticketCode).toMatch(/^TK-/);
    const msgs = await db.ticketMessage.findMany({ where: { ticketId: tk.id } });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ authorId: t.owner.id, body: TICKET.body });
    const a = await db.auditLog.findFirstOrThrow({ where: { action: "support.create", entityId: tk.id } });
    expect(a).toMatchObject({ clientId: t.client.id, actorId: t.owner.id });
    expect(await db.notification.count({ where: { type: "support.new" } })).toBeGreaterThan(0);
    expect(admin.admin.id).toBeTruthy();
  });

  it("works without a business, with a chosen priority, and treats an empty businessId as none", async () => {
    const t = await makeClientTenant();
    const tk = await createTicket(t.ctx, { ...TICKET, priority: "HIGH", businessId: "" });
    expect(tk).toMatchObject({ priority: "HIGH", businessId: null });
  });

  it("refuses a foreign or unknown businessId with 404 and creates nothing", async () => {
    const t = await makeClientTenant();
    const other = await makeClientTenant();
    await expectAppError(createTicket(t.ctx, { ...TICKET, businessId: other.business.id }), "NOT_FOUND");
    await expectAppError(createTicket(t.ctx, { ...TICKET, businessId: "does-not-exist" }), "NOT_FOUND");
    expect(await db.supportTicket.count()).toBe(0);
  });

  it("a manager cannot raise a ticket against a business they do not belong to", async () => {
    const t = await makeClientTenant();
    const second = await db.business.create({ data: { businessCode: "BZ-SUP00001", clientId: t.client.id, name: "Other Shop", category: "retail", status: "ACTIVE" } });
    const mgr = await makeManager(t);
    await expectAppError(createTicket(mgr.ctx, { ...TICKET, businessId: second.id }), "NOT_FOUND");
    const ok = await createTicket(mgr.ctx, { ...TICKET, businessId: t.business.id });
    expect(ok.businessId).toBe(t.business.id);
  });

  it.each([
    ["short subject", { subject: "ab" }],
    ["empty subject", { subject: "" }],
    ["long subject", { subject: "s".repeat(151) }],
    ["short body", { body: "ab" }],
    ["whitespace body", { body: "     " }],
    ["long body", { body: "b".repeat(5001) }],
    ["bad priority", { priority: "URGENT" }],
    ["non-string subject", { subject: 42 }],
  ])("rejects bad input (%s) with VALIDATION", async (_n, patch) => {
    const t = await makeClientTenant();
    await expectAppError(createTicket(t.ctx, { ...TICKET, ...patch }), "VALIDATION");
    await expectAppError(createTicket(t.ctx, undefined), "VALIDATION");
    expect(await db.supportTicket.count()).toBe(0);
  });

  it("needs the support.use permission; admins and anonymous callers cannot use the client side", async () => {
    const noSupport = await makeClientTenant({ permissions: ["qr.manage"] });
    await expectAppError(createTicket(noSupport.ctx, TICKET), "FORBIDDEN");
    await expectAppError(listMyTickets(noSupport.ctx, {}), "FORBIDDEN");
    const admin = await adminSession();
    await expectAppError(createTicket(admin.ctx, TICKET), "FORBIDDEN");
    await expectAppError(createTicket(anonCtx(), TICKET), "UNAUTHENTICATED");
    expect(await db.supportTicket.count()).toBe(0);
  });
});

describe("conversation and status flow", () => {
  it("admin reply moves OPEN to IN_PROGRESS; a client reply on a RESOLVED ticket reopens it", async () => {
    const admin = await adminSession();
    const t = await makeClientTenant();
    const tk = await createTicket(t.ctx, TICKET);
    await replyToTicket(admin.ctx, tk.id, { body: "We are looking into it." });
    expect((await getTicket(admin.ctx, tk.id)).status).toBe("IN_PROGRESS");
    // a second admin reply does not change status again
    await replyToTicket(admin.ctx, tk.id, { body: "Still checking." });
    expect((await getTicket(admin.ctx, tk.id)).status).toBe("IN_PROGRESS");
    // the client is told in-app
    expect(await db.notification.count({ where: { type: "support.reply", userId: t.owner.id, channel: "IN_APP" } })).toBe(2);

    await setTicketStatus(admin.ctx, tk.id, { status: "RESOLVED" });
    await replyToTicket(t.ctx, tk.id, { body: "It is still not fixed." });
    const after = await getTicket(t.ctx, tk.id);
    expect(after.status).toBe("OPEN");
    expect(after.messages.map((m) => m.author.role)).toEqual(["CLIENT", "SUPER_ADMIN", "SUPER_ADMIN", "CLIENT"]);
    expect(await db.auditLog.count({ where: { action: "support.reply", entityId: tk.id } })).toBe(3);
  });

  it("a client reply on an IN_PROGRESS ticket leaves the status alone", async () => {
    const admin = await adminSession();
    const t = await makeClientTenant();
    const tk = await createTicket(t.ctx, TICKET);
    await replyToTicket(admin.ctx, tk.id, { body: "Looking into it." });
    await replyToTicket(t.ctx, tk.id, { body: "Thank you." });
    expect((await getTicket(t.ctx, tk.id)).status).toBe("IN_PROGRESS");
  });

  it("a closed ticket accepts no replies from either side, and closing twice is harmless", async () => {
    const admin = await adminSession();
    const t = await makeClientTenant();
    const tk = await createTicket(t.ctx, TICKET);
    expect(await closeMyTicket(t.ctx, tk.id)).toEqual({ status: "CLOSED" });
    expect(await closeMyTicket(t.ctx, tk.id)).toEqual({ status: "CLOSED" });
    expect(await db.auditLog.count({ where: { action: "support.close" } })).toBe(1);
    await expectAppError(replyToTicket(t.ctx, tk.id, { body: "One more thing" }), "BAD_REQUEST");
    await expectAppError(replyToTicket(admin.ctx, tk.id, { body: "One more thing" }), "BAD_REQUEST");
    expect(await db.ticketMessage.count({ where: { ticketId: tk.id } })).toBe(1);
  });

  it("rejects bad reply bodies", async () => {
    const t = await makeClientTenant();
    const tk = await createTicket(t.ctx, TICKET);
    await expectAppError(replyToTicket(t.ctx, tk.id, { body: "" }), "VALIDATION");
    await expectAppError(replyToTicket(t.ctx, tk.id, { body: "  x " }), "VALIDATION");
    await expectAppError(replyToTicket(t.ctx, tk.id, { body: "y".repeat(5001) }), "VALIDATION");
    await expectAppError(replyToTicket(t.ctx, tk.id, {}), "VALIDATION");
    expect(await db.ticketMessage.count({ where: { ticketId: tk.id } })).toBe(1);
  });

  it("admin sets status and priority with audit entries (from and to) and notifies the client only on a real change", async () => {
    const admin = await adminSession();
    const t = await makeClientTenant();
    const tk = await createTicket(t.ctx, TICKET);
    const s = await setTicketStatus(admin.ctx, tk.id, { status: "RESOLVED" });
    expect(s.status).toBe("RESOLVED");
    const p = await setTicketPriority(admin.ctx, tk.id, { priority: "HIGH" });
    expect(p.priority).toBe("HIGH");
    const sa = await db.auditLog.findFirstOrThrow({ where: { action: "support.status", entityId: tk.id } });
    expect(sa.metadata).toMatchObject({ from: "OPEN", to: "RESOLVED" });
    const pa = await db.auditLog.findFirstOrThrow({ where: { action: "support.priority", entityId: tk.id } });
    expect(pa.metadata).toMatchObject({ from: "NORMAL", to: "HIGH" });
    expect(await db.notification.count({ where: { type: "support.status", userId: t.owner.id, channel: "IN_APP" } })).toBe(1);
    await setTicketStatus(admin.ctx, tk.id, { status: "RESOLVED" }); // same value
    expect(await db.notification.count({ where: { type: "support.status", userId: t.owner.id, channel: "IN_APP" } })).toBe(1);
  });

  it("rejects invalid status and priority, unknown tickets, and non-admin callers", async () => {
    const admin = await adminSession();
    const t = await makeClientTenant();
    const tk = await createTicket(t.ctx, TICKET);
    await expectAppError(setTicketStatus(admin.ctx, tk.id, { status: "DONE" }), "VALIDATION");
    await expectAppError(setTicketStatus(admin.ctx, tk.id, {}), "VALIDATION");
    await expectAppError(setTicketPriority(admin.ctx, tk.id, { priority: "urgent" }), "VALIDATION");
    await expectAppError(setTicketStatus(admin.ctx, "missing", { status: "OPEN" }), "NOT_FOUND");
    await expectAppError(setTicketPriority(admin.ctx, "", { priority: "LOW" }), "NOT_FOUND");
    await expectAppError(setTicketStatus(t.ctx, tk.id, { status: "RESOLVED" }), "FORBIDDEN");
    await expectAppError(setTicketPriority(t.ctx, tk.id, { priority: "LOW" }), "FORBIDDEN");
    await expectAppError(setTicketStatus(anonCtx(), tk.id, { status: "RESOLVED" }), "UNAUTHENTICATED");
    const row = await db.supportTicket.findUniqueOrThrow({ where: { id: tk.id } });
    expect(row).toMatchObject({ status: "OPEN", priority: "NORMAL" });
    expect(await db.auditLog.count({ where: { action: { in: ["support.status", "support.priority"] } } })).toBe(0);
  });
});

describe("visibility", () => {
  it("another client gets 404 on read, reply and close, and nothing changes", async () => {
    const t = await makeClientTenant();
    const other = await makeClientTenant();
    const tk = await createTicket(t.ctx, TICKET);
    await expectAppError(getTicket(other.ctx, tk.id), "NOT_FOUND");
    await expectAppError(replyToTicket(other.ctx, tk.id, { body: "intruder reply" }), "NOT_FOUND");
    await expectAppError(closeMyTicket(other.ctx, tk.id), "NOT_FOUND");
    await expectAppError(getTicket(t.ctx, "nope"), "NOT_FOUND");
    await expectAppError(getTicket(anonCtx(), tk.id), "UNAUTHENTICATED");
    expect((await listMyTickets(other.ctx, {})).total).toBe(0);
    const row = await db.supportTicket.findUniqueOrThrow({ where: { id: tk.id } });
    expect(row.status).toBe("OPEN");
    expect(await db.ticketMessage.count({ where: { ticketId: tk.id } })).toBe(1);
  });

  it("owners see every ticket of the account; managers only their own or those of their businesses", async () => {
    const t = await makeClientTenant();
    const second = await db.business.create({ data: { businessCode: "BZ-SUP00002", clientId: t.client.id, name: "Other Shop", category: "retail", status: "ACTIVE" } });
    const mgr = await makeManager(t);
    const ownerNoBiz = await createTicket(t.ctx, { subject: "Account question", body: "A general question." });
    const ownerOnOther = await db.supportTicket.create({ data: { ticketCode: "TK-OTHER1", clientId: t.client.id, businessId: second.id, createdById: t.owner.id, subject: "Other shop issue" } });
    const ownerOnMine = await createTicket(t.ctx, { ...TICKET, businessId: t.business.id });
    const mgrOwn = await createTicket(mgr.ctx, { subject: "Manager ticket", body: "Raised by the manager." });

    expect((await listMyTickets(t.ctx, {})).items.map((i) => i.id).sort()).toEqual([ownerNoBiz.id, ownerOnOther.id, ownerOnMine.id, mgrOwn.id].sort());
    expect((await listMyTickets(mgr.ctx, {})).items.map((i) => i.id).sort()).toEqual([ownerOnMine.id, mgrOwn.id].sort());
    await expectAppError(getTicket(mgr.ctx, ownerNoBiz.id), "NOT_FOUND");
    await expectAppError(getTicket(mgr.ctx, ownerOnOther.id), "NOT_FOUND");
    await expectAppError(replyToTicket(mgr.ctx, ownerOnOther.id, { body: "not mine to answer" }), "NOT_FOUND");
    await expectAppError(closeMyTicket(mgr.ctx, ownerNoBiz.id), "NOT_FOUND");
    expect((await getTicket(t.ctx, mgrOwn.id)).id).toBe(mgrOwn.id);
    expect((await getTicket(mgr.ctx, ownerOnMine.id)).id).toBe(ownerOnMine.id);
  });

  it("filters and paginates; bad filter values are ignored rather than failing", async () => {
    const admin = await adminSession();
    const a = await makeClientTenant();
    const b = await makeClientTenant();
    const t1 = await createTicket(a.ctx, { ...TICKET, priority: "HIGH" });
    await createTicket(a.ctx, { subject: "Refund question", body: "How do refunds work?" });
    await createTicket(b.ctx, { subject: "Logo upload fails", body: "The upload keeps failing." });
    await setTicketStatus(admin.ctx, t1.id, { status: "RESOLVED" });

    expect((await listAllTickets(admin.ctx, {})).total).toBe(3);
    expect((await listAllTickets(admin.ctx, { status: "RESOLVED" })).items.map((i) => i.id)).toEqual([t1.id]);
    expect((await listAllTickets(admin.ctx, { priority: "HIGH" })).total).toBe(1);
    expect((await listAllTickets(admin.ctx, { clientId: b.client.id })).total).toBe(1);
    expect((await listAllTickets(admin.ctx, { q: "refund" })).total).toBe(1);
    expect((await listAllTickets(admin.ctx, { q: t1.ticketCode.toLowerCase() })).total).toBe(1);
    expect((await listAllTickets(admin.ctx, { status: "bogus", priority: "bogus" })).total).toBe(3);
    const page = await listAllTickets(admin.ctx, { page: 2, pageSize: 2 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(3);
    // a client's list ignores a clientId filter that points elsewhere
    expect((await listMyTickets(a.ctx, { clientId: b.client.id })).items.every((i) => i.clientId === a.client.id)).toBe(true);
    expect((await listMyTickets(a.ctx, { status: "RESOLVED" })).total).toBe(1);
    await expectAppError(listAllTickets(a.ctx, {}), "FORBIDDEN");
    await expectAppError(listAllTickets(anonCtx(), {}), "UNAUTHENTICATED");
  });

  it("an admin can read any ticket including the full message thread", async () => {
    const admin = await adminSession();
    const t = await makeClientTenant();
    const tk = await createTicket(t.ctx, TICKET);
    const full = await getTicket(admin.ctx, tk.id);
    expect(full.client.id).toBe(t.client.id);
    expect(full.messages).toHaveLength(1);
    expect(full.creator.email).toBe(t.owner.email);
  });
});
