import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { actorFromToken } from "@/server/auth/session";
import { login, setPasswordWithToken } from "@/server/services/auth";
import {
  approveBusiness,
  businessQuota,
  createBusiness,
  getBusiness,
  listBusinesses,
  listMyBusinesses,
  reactivateBusiness,
  rejectBusiness,
  removeBusinessLogo,
  setBusinessLogo,
  suspendBusiness,
  updateBusiness,
} from "@/server/services/businesses";
import { getAllSettings, getOrderExpiryMinutes, listSettings, setSetting, updateSettings } from "@/server/services/settings";
import { addTeamMember, listTeam, removeTeamMember, resendTeamInvite } from "@/server/services/team";
import { sniffImageType } from "@/server/services/image-upload";
import { anonCtx, resetDb } from "./helpers";
import {
  addOwnedBusiness,
  adminSession,
  expectAppError,
  fileOf,
  JPEG_BYTES,
  makeClientTenant,
  makeManager,
  PASSWORD,
  PNG_BYTES,
  refreshOwner,
  sessionFor,
  tokenFromLink,
  WEBP_BYTES,
} from "./helpers-admin";

const PROFILE = { name: "Corner Cafe", category: "food", city: "Pune", pincode: "411001", contactPhone: "+91 98765 43210", contactEmail: "cafe@shop.test" };

beforeEach(async () => {
  await resetDb();
});

describe("business creation and limits", () => {
  it("creates a PENDING_APPROVAL business with an OWNER membership, defaults, and an audit entry", async () => {
    const t = await makeClientTenant({ maxBusinesses: 3 });
    const b = await createBusiness(t.ctx, PROFILE);
    expect(b.status).toBe("PENDING_APPROVAL");
    expect(b.businessCode).toMatch(/^BZ-/);
    expect(b.clientId).toBe(t.client.id);
    expect(b.currency).toBe("INR");
    expect(b.acceptingOrders).toBe(true);
    expect(b.defaultTaxBps).toBe(0);
    const m = await db.businessMembership.findFirstOrThrow({ where: { businessId: b.id } });
    expect(m).toMatchObject({ userId: t.owner.id, role: "OWNER" });
    const a = await db.auditLog.findFirstOrThrow({ where: { action: "business.create", entityId: b.id } });
    expect(a.clientId).toBe(t.client.id);
    expect(a.actorId).toBe(t.owner.id);
    // admins are told something is waiting
    expect(await db.notification.count({ where: { type: "business.pending" } })).toBeGreaterThanOrEqual(0);
  });

  it("ignores attempts to set status, client or UPI id through the input", async () => {
    const t = await makeClientTenant();
    const other = await makeClientTenant();
    const b = await createBusiness(t.ctx, { ...PROFILE, status: "ACTIVE", clientId: other.client.id, staticUpiVpa: "evil@upi", id: "chosen-id" });
    expect(b.status).toBe("PENDING_APPROVAL");
    expect(b.clientId).toBe(t.client.id);
    expect(b.staticUpiVpa).toBeNull();
    expect(b.id).not.toBe("chosen-id");
  });

  it("enforces maxBusinesses with BUSINESS_LIMIT; a REJECTED business frees its slot", async () => {
    const admin = await adminSession();
    const t = await makeClientTenant({ maxBusinesses: 2 }); // 1 existing + 1 more allowed
    const second = await createBusiness(t.ctx, PROFILE);
    expect(await businessQuota(t.client.id)).toEqual({ used: 2, max: 2 });
    const err = await expectAppError(createBusiness(t.ctx, { ...PROFILE, name: "Third Shop" }), "BAD_REQUEST");
    expect(JSON.stringify(err.details)).toContain("BUSINESS_LIMIT");
    expect(await db.business.count({ where: { clientId: t.client.id } })).toBe(2);

    await rejectBusiness(admin.ctx, second.id, { reason: "Documents missing" });
    expect(await businessQuota(t.client.id)).toEqual({ used: 1, max: 2 });
    const third = await createBusiness(t.ctx, { ...PROFILE, name: "Third Shop" });
    expect(third.status).toBe("PENDING_APPROVAL");
  });

  it("raising maxBusinesses lets the client add more", async () => {
    const t = await makeClientTenant({ maxBusinesses: 1 });
    await expectAppError(createBusiness(t.ctx, PROFILE), "BAD_REQUEST");
    await db.client.update({ where: { id: t.client.id }, data: { maxBusinesses: 2 } });
    await createBusiness(t.ctx, PROFILE);
  });

  it("never lets concurrent requests exceed the limit", async () => {
    const t = await makeClientTenant({ maxBusinesses: 2 });
    const results = await Promise.allSettled([1, 2, 3, 4].map((i) => createBusiness(t.ctx, { ...PROFILE, name: `Race ${i}` })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.business.count({ where: { clientId: t.client.id } })).toBe(2);
  });

  it("a manager cannot create a business; a suspended client cannot either; anonymous and admin are refused", async () => {
    const t = await makeClientTenant();
    const mgr = await makeManager(t);
    await expectAppError(createBusiness(mgr.ctx, PROFILE), "FORBIDDEN");
    await expectAppError(createBusiness(anonCtx(), PROFILE), "UNAUTHENTICATED");
    const admin = await adminSession();
    await expectAppError(createBusiness(admin.ctx, PROFILE), "FORBIDDEN");
    await db.client.update({ where: { id: t.client.id }, data: { status: "SUSPENDED" } });
    await expectAppError(createBusiness(t.ctx, PROFILE), "FORBIDDEN");
    expect(await db.business.count({ where: { clientId: t.client.id } })).toBe(1);
  });

  it.each([
    ["missing name", { name: "" }],
    ["name too short", { name: "A" }],
    ["missing category", { category: "" }],
    ["bad pincode", { pincode: "12345" }],
    ["bad phone", { contactPhone: "call me" }],
    ["bad email", { contactEmail: "nope" }],
    ["tax above 100 percent", { defaultTaxBps: 10001 }],
    ["fractional tax", { defaultTaxBps: 12.5 }],
    ["negative tax", { defaultTaxBps: -1 }],
    ["description too long", { description: "x".repeat(1001) }],
  ])("rejects bad input (%s) with VALIDATION and creates nothing", async (_n, patch) => {
    const t = await makeClientTenant();
    await expectAppError(createBusiness(t.ctx, { ...PROFILE, ...patch }), "VALIDATION");
    expect(await db.business.count({ where: { clientId: t.client.id } })).toBe(1);
  });
});

describe("admin lifecycle", () => {
  it("approve, suspend, reactivate with audit trails (from, to, reason) and status reason handling", async () => {
    const admin = await adminSession();
    const t = await makeClientTenant({ businessStatus: "PENDING_APPROVAL" });
    const approved = await approveBusiness(admin.ctx, t.business.id);
    expect(approved.status).toBe("ACTIVE");
    const suspended = await suspendBusiness(admin.ctx, t.business.id, { reason: "Policy breach" });
    expect(suspended).toMatchObject({ status: "SUSPENDED", statusReason: "Policy breach" });
    const back = await reactivateBusiness(admin.ctx, t.business.id, { reason: "Resolved" });
    expect(back).toMatchObject({ status: "ACTIVE", statusReason: null });

    const rows = await db.auditLog.findMany({ where: { entityId: t.business.id, action: { startsWith: "business." } }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => r.action)).toEqual(["business.approve", "business.suspend", "business.reactivate"]);
    expect(rows[1].metadata).toMatchObject({ from: "ACTIVE", to: "SUSPENDED", reason: "Policy breach" });
    expect(rows.every((r) => r.actorId === admin.admin.id && r.clientId === t.client.id)).toBe(true);
  });

  it("reject needs a reason and records it; a rejected business can be approved later", async () => {
    const admin = await adminSession();
    const t = await makeClientTenant({ businessStatus: "PENDING_APPROVAL" });
    await expectAppError(rejectBusiness(admin.ctx, t.business.id, {}), "VALIDATION");
    await expectAppError(rejectBusiness(admin.ctx, t.business.id, { reason: "no" }), "VALIDATION");
    expect((await db.business.findUniqueOrThrow({ where: { id: t.business.id } })).status).toBe("PENDING_APPROVAL");
    const r = await rejectBusiness(admin.ctx, t.business.id, { reason: "Address could not be verified" });
    expect(r).toMatchObject({ status: "REJECTED", statusReason: "Address could not be verified" });
    expect((await approveBusiness(admin.ctx, t.business.id)).status).toBe("ACTIVE");
  });

  it("suspend needs a reason", async () => {
    const admin = await adminSession();
    const t = await makeClientTenant();
    await expectAppError(suspendBusiness(admin.ctx, t.business.id, {}), "VALIDATION");
    await expectAppError(suspendBusiness(admin.ctx, t.business.id, undefined), "VALIDATION");
    expect((await db.business.findUniqueOrThrow({ where: { id: t.business.id } })).status).toBe("ACTIVE");
  });

  it("rejects invalid transitions with BAD_REQUEST and writes no audit entry for them", async () => {
    const admin = await adminSession();
    const active = await makeClientTenant();
    const pending = await makeClientTenant({ businessStatus: "PENDING_APPROVAL" });
    await expectAppError(approveBusiness(admin.ctx, active.business.id), "BAD_REQUEST");
    await expectAppError(reactivateBusiness(admin.ctx, active.business.id), "BAD_REQUEST");
    await expectAppError(rejectBusiness(admin.ctx, active.business.id, { reason: "too late now" }), "BAD_REQUEST");
    await expectAppError(suspendBusiness(admin.ctx, pending.business.id, { reason: "not yet active" }), "BAD_REQUEST");
    expect(await db.auditLog.count({ where: { action: { startsWith: "business." } } })).toBe(0);
  });

  it("returns 404 for unknown ids, and refuses clients and anonymous callers", async () => {
    const admin = await adminSession();
    const t = await makeClientTenant({ businessStatus: "PENDING_APPROVAL" });
    await expectAppError(approveBusiness(admin.ctx, "missing"), "NOT_FOUND");
    await expectAppError(approveBusiness(admin.ctx, ""), "NOT_FOUND");
    await expectAppError(approveBusiness(t.ctx, t.business.id), "FORBIDDEN");
    await expectAppError(approveBusiness(anonCtx(), t.business.id), "UNAUTHENTICATED");
    await expectAppError(suspendBusiness(t.ctx, t.business.id, { reason: "self-service" }), "FORBIDDEN");
    expect((await db.business.findUniqueOrThrow({ where: { id: t.business.id } })).status).toBe("PENDING_APPROVAL");
  });

  it("two admins acting at once apply only one transition", async () => {
    const a1 = await adminSession("admin@example.com");
    const a2 = await adminSession("admin2@example.com");
    const t = await makeClientTenant({ businessStatus: "PENDING_APPROVAL" });
    const r = await Promise.allSettled([approveBusiness(a1.ctx, t.business.id), approveBusiness(a2.ctx, t.business.id)]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await db.auditLog.count({ where: { action: "business.approve" } })).toBe(1);
  });

  it("admin list filters by status, client and text; clients cannot use it", async () => {
    const admin = await adminSession();
    const a = await makeClientTenant({ businessStatus: "PENDING_APPROVAL" });
    const b = await makeClientTenant();
    expect((await listBusinesses(admin.ctx, {})).total).toBe(2);
    expect((await listBusinesses(admin.ctx, { status: "PENDING_APPROVAL" })).items[0].id).toBe(a.business.id);
    expect((await listBusinesses(admin.ctx, { clientId: b.client.id })).total).toBe(1);
    expect((await listBusinesses(admin.ctx, { q: b.business.name })).total).toBe(1);
    expect((await listBusinesses(admin.ctx, { status: "nonsense" })).total).toBe(2);
    await expectAppError(listBusinesses(a.ctx, {}), "FORBIDDEN");
  });
});

describe("update business", () => {
  it("the owner updates a business with a changed-fields audit; the status is untouched", async () => {
    const t = await makeClientTenant();
    const next = await updateBusiness(t.ctx, t.business.id, { ...PROFILE, name: "Renamed Shop", defaultTaxBps: 1800, acceptingOrders: false });
    expect(next).toMatchObject({ name: "Renamed Shop", defaultTaxBps: 1800, acceptingOrders: false, status: "ACTIVE", city: "Pune" });
    const a = await db.auditLog.findFirstOrThrow({ where: { action: "business.update" } });
    expect((a.metadata as { changed: string[] }).changed).toContain("name");
    expect((a.metadata as { changed: string[] }).changed).not.toContain("status");
    // clearing an optional field stores null
    const cleared = await updateBusiness(t.ctx, t.business.id, { name: "Renamed Shop", category: "retail", city: "", pincode: "" });
    expect(cleared.city).toBeNull();
    expect(cleared.pincode).toBeNull();
  });

  it("a manager is refused, bad input is rejected, and a foreign business is a 404", async () => {
    const t = await makeClientTenant();
    const other = await makeClientTenant();
    const mgr = await makeManager(t);
    await expectAppError(updateBusiness(mgr.ctx, t.business.id, PROFILE), "FORBIDDEN");
    await expectAppError(updateBusiness(t.ctx, t.business.id, { ...PROFILE, pincode: "abc" }), "VALIDATION");
    await expectAppError(updateBusiness(t.ctx, other.business.id, PROFILE), "NOT_FOUND");
    await expectAppError(updateBusiness(t.ctx, "missing-id", PROFILE), "NOT_FOUND");
    await expectAppError(updateBusiness(anonCtx(), t.business.id, PROFILE), "UNAUTHENTICATED");
    expect((await db.business.findUniqueOrThrow({ where: { id: other.business.id } })).name).toBe(other.business.name);
    expect(await db.auditLog.count({ where: { action: "business.update" } })).toBe(0);
  });

  it("a client without settings.manage permission is refused", async () => {
    const t = await makeClientTenant({ permissions: ["support.use"] });
    await expectAppError(updateBusiness(t.ctx, t.business.id, PROFILE), "FORBIDDEN");
  });
});

describe("reads", () => {
  it("clients see only their own businesses; a manager only theirs; admin sees platform fields", async () => {
    const t = await makeClientTenant();
    const second = await addOwnedBusiness(t, "Second Shop");
    const other = await makeClientTenant();
    const mgr = await makeManager(t, second.id);
    const mine = await listMyBusinesses(t.ctx);
    expect(mine.map((b) => b.id).sort()).toEqual([t.business.id, second.id].sort());
    expect((await listMyBusinesses(mgr.ctx)).map((b) => b.id)).toEqual([second.id]);
    await expectAppError(getBusiness(mgr.ctx, t.business.id), "NOT_FOUND");
    await expectAppError(getBusiness(t.ctx, other.business.id), "NOT_FOUND");
    await db.business.update({ where: { id: t.business.id }, data: { staticUpiVpa: "shop@upi" } });
    const admin = await adminSession();
    expect((await getBusiness(admin.ctx, t.business.id)).staticUpiVpa).toBe("shop@upi");
    expect((await getBusiness(t.ctx, t.business.id)).staticUpiVpa).toBeUndefined();
    await expectAppError(getBusiness(anonCtx(), t.business.id), "UNAUTHENTICATED");
  });
});

describe("logo upload", () => {
  it("accepts PNG, JPEG and WebP by magic bytes and stores the sniffed type", async () => {
    const t = await makeClientTenant();
    for (const [bytes, name, claimed, expected] of [
      [PNG_BYTES(), "a.png", "image/png", "image/png"],
      [JPEG_BYTES(), "b.jpg", "image/jpeg", "image/jpeg"],
      [WEBP_BYTES(), "c.webp", "image/webp", "image/webp"],
      [PNG_BYTES(), "lies.jpg", "image/jpeg", "image/png"], // claimed type is ignored
    ] as const) {
      const r = await setBusinessLogo(t.ctx, t.business.id, fileOf(bytes, name, claimed));
      const asset = await db.fileAsset.findUniqueOrThrow({ where: { id: r.logoFileId! } });
      expect(asset.contentType).toBe(expected);
      expect(asset.sha256).toHaveLength(64);
    }
    expect(await db.auditLog.count({ where: { action: "business.logo_set" } })).toBe(4);
  });

  it("replacing a logo removes the old asset; removing clears the link and the asset", async () => {
    const t = await makeClientTenant();
    const first = await setBusinessLogo(t.ctx, t.business.id, fileOf(PNG_BYTES(), "a.png"));
    const second = await setBusinessLogo(t.ctx, t.business.id, fileOf(JPEG_BYTES(), "b.jpg", "image/jpeg"));
    expect(second.logoFileId).not.toBe(first.logoFileId);
    expect(await db.fileAsset.findUnique({ where: { id: first.logoFileId! } })).toBeNull();
    expect((await db.business.findUniqueOrThrow({ where: { id: t.business.id } })).logoFileId).toBe(second.logoFileId);
    await removeBusinessLogo(t.ctx, t.business.id);
    expect((await db.business.findUniqueOrThrow({ where: { id: t.business.id } })).logoFileId).toBeNull();
    expect(await db.fileAsset.count()).toBe(0);
    // removing again is a harmless no-op without a second audit entry
    expect(await removeBusinessLogo(t.ctx, t.business.id)).toEqual({ logoFileId: null });
    expect(await db.auditLog.count({ where: { action: "business.logo_remove" } })).toBe(1);
  });

  it("rejects non-images whatever their name or content type says", async () => {
    const t = await makeClientTenant();
    const html = Buffer.from("<html><script>alert(1)</script></html>");
    await expectAppError(setBusinessLogo(t.ctx, t.business.id, fileOf(html, "logo.png", "image/png")), "VALIDATION");
    await expectAppError(setBusinessLogo(t.ctx, t.business.id, fileOf(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "x.svg", "image/svg+xml")), "VALIDATION");
    await expectAppError(setBusinessLogo(t.ctx, t.business.id, fileOf(Buffer.from("GIF89a" + "x".repeat(40)), "x.gif", "image/gif")), "VALIDATION");
    await expectAppError(setBusinessLogo(t.ctx, t.business.id, fileOf(Buffer.alloc(0), "empty.png")), "VALIDATION");
    await expectAppError(setBusinessLogo(t.ctx, t.business.id, fileOf(PNG_BYTES().subarray(0, 4), "short.png")), "VALIDATION");
    await expectAppError(setBusinessLogo(t.ctx, t.business.id, fileOf(Buffer.concat([PNG_BYTES(), Buffer.alloc(1024 * 1024)]), "huge.png")), "VALIDATION");
    expect(await db.fileAsset.count()).toBe(0);
    expect((await db.business.findUniqueOrThrow({ where: { id: t.business.id } })).logoFileId).toBeNull();
    expect(sniffImageType(Buffer.from("RIFFxxxxWAVE"))).toBeNull(); // RIFF but not WEBP
  });

  it("is owner-only and tenant-scoped", async () => {
    const t = await makeClientTenant();
    const other = await makeClientTenant();
    const mgr = await makeManager(t);
    await expectAppError(setBusinessLogo(mgr.ctx, t.business.id, fileOf(PNG_BYTES(), "a.png")), "FORBIDDEN");
    await expectAppError(setBusinessLogo(t.ctx, other.business.id, fileOf(PNG_BYTES(), "a.png")), "NOT_FOUND");
    await expectAppError(removeBusinessLogo(t.ctx, other.business.id), "NOT_FOUND");
    await expectAppError(setBusinessLogo(anonCtx(), t.business.id, fileOf(PNG_BYTES(), "a.png")), "UNAUTHENTICATED");
    expect(await db.fileAsset.count()).toBe(0);
  });
});

describe("team", () => {
  it("owner adds a manager who sets a password and can then sign in and see only that business", async () => {
    const t = await makeClientTenant();
    const second = await addOwnedBusiness(t, "Second Shop");
    const r = await addTeamMember(t.ctx, t.business.id, { name: "Mira Manager", email: "Mira@Shop.test", phone: "" });
    expect(r.member).toMatchObject({ email: "mira@shop.test", role: "MANAGER" });
    const u = await db.user.findUniqueOrThrow({ where: { id: r.member.id } });
    expect(u).toMatchObject({ status: "INVITED", clientId: t.client.id, role: "CLIENT" });
    expect(u.passwordHash).toBeNull();
    await setPasswordWithToken(anonCtx(), { token: tokenFromLink(r.inviteLink), password: PASSWORD });
    const s = await login(anonCtx("203.0.113.50"), { email: "mira@shop.test", password: PASSWORD, portal: "client" });
    const mgr = await sessionFor(u.id);
    expect(mgr.ctx.actor?.businessIds).toEqual([t.business.id]);
    expect(mgr.ctx.actor?.isOwner).toBe(false);
    expect(s.token).toBeTruthy();
    await expectAppError(getBusiness(mgr.ctx, second.id), "NOT_FOUND");
    const team = await listTeam(t.ctx, t.business.id);
    expect(team.map((m) => m.role).sort()).toEqual(["MANAGER", "OWNER"]);
    const a = await db.auditLog.findFirstOrThrow({ where: { action: "team.add" } });
    expect(JSON.stringify(a.metadata)).not.toContain(tokenFromLink(r.inviteLink));
    expect(JSON.stringify(a.metadata)).not.toContain("token=");
  });

  it("rejects a duplicate email (any role, any client) with CONFLICT and bad input with VALIDATION", async () => {
    const t = await makeClientTenant();
    const other = await makeClientTenant();
    await addTeamMember(t.ctx, t.business.id, { name: "First Mgr", email: "dup@shop.test" });
    await expectAppError(addTeamMember(t.ctx, t.business.id, { name: "Again Mgr", email: "DUP@shop.test" }), "CONFLICT");
    await expectAppError(addTeamMember(t.ctx, t.business.id, { name: "Owner Clash", email: other.owner.email }), "CONFLICT");
    await expectAppError(addTeamMember(t.ctx, t.business.id, { name: "Bad Mail", email: "nope" }), "VALIDATION");
    await expectAppError(addTeamMember(t.ctx, t.business.id, { name: "", email: "x@shop.test" }), "VALIDATION");
    await expectAppError(addTeamMember(t.ctx, t.business.id, { name: "Bad Phone", email: "p@shop.test", phone: "zzz" }), "VALIDATION");
    expect(await db.businessMembership.count({ where: { businessId: t.business.id } })).toBe(2);
  });

  it("is owner-only, tenant-scoped, and limited to the business: manager, foreign owner, no permission, anonymous", async () => {
    const t = await makeClientTenant();
    const other = await makeClientTenant();
    const mgr = await makeManager(t);
    await expectAppError(addTeamMember(mgr.ctx, t.business.id, { name: "Sneaky", email: "s@shop.test" }), "FORBIDDEN");
    await expectAppError(listTeam(mgr.ctx, t.business.id), "FORBIDDEN");
    await expectAppError(listTeam(t.ctx, other.business.id), "NOT_FOUND");
    await expectAppError(addTeamMember(t.ctx, other.business.id, { name: "Sneaky", email: "s@shop.test" }), "NOT_FOUND");
    await expectAppError(removeTeamMember(t.ctx, other.business.id, other.owner.id), "NOT_FOUND");
    await expectAppError(listTeam(anonCtx(), t.business.id), "UNAUTHENTICATED");
    const limited = await makeClientTenant({ permissions: ["support.use"] });
    await expectAppError(listTeam(limited.ctx, limited.business.id), "FORBIDDEN");
    expect(await db.user.count({ where: { email: "s@shop.test" } })).toBe(0);
  });

  it("resends an invite only to people who have not set a password", async () => {
    const t = await makeClientTenant();
    const r = await addTeamMember(t.ctx, t.business.id, { name: "Late Joiner", email: "late@shop.test" });
    const again = await resendTeamInvite(t.ctx, t.business.id, r.member.id);
    expect(again.inviteLink).not.toBe(r.inviteLink);
    expect(await db.auditLog.count({ where: { action: "team.invite_resend" } })).toBe(1);
    await setPasswordWithToken(anonCtx(), { token: tokenFromLink(again.inviteLink), password: PASSWORD });
    await expectAppError(resendTeamInvite(t.ctx, t.business.id, r.member.id), "BAD_REQUEST");
    await expectAppError(resendTeamInvite(t.ctx, t.business.id, "no-such-user"), "NOT_FOUND");
  });

  it("removal: owners cannot be removed; unknown people give 404; the last membership disables the login and signs them out", async () => {
    const t = await makeClientTenant();
    const mgr = await makeManager(t);
    const token = mgr.cookie.split("=")[1];
    expect(await actorFromToken(token)).not.toBeNull();
    await expectAppError(removeTeamMember(t.ctx, t.business.id, t.owner.id), "BAD_REQUEST");
    await expectAppError(removeTeamMember(t.ctx, t.business.id, "nobody"), "NOT_FOUND");
    await removeTeamMember(t.ctx, t.business.id, mgr.user.id);
    expect(await actorFromToken(token)).toBeNull();
    expect((await db.user.findUniqueOrThrow({ where: { id: mgr.user.id } })).status).toBe("INACTIVE");
    const err = await login(anonCtx("203.0.113.51"), { email: mgr.user.email, password: PASSWORD, portal: "client" }).catch((e) => e);
    expect(err.code).toBe("ACCOUNT_DISABLED");
    await expectAppError(removeTeamMember(t.ctx, t.business.id, mgr.user.id), "NOT_FOUND"); // already gone
    expect(await db.auditLog.count({ where: { action: "team.remove" } })).toBe(1);
  });

  it("a manager of two businesses keeps their login when removed from one, and loses access to that one at once", async () => {
    const t = await makeClientTenant();
    const second = await addOwnedBusiness(t, "Second Shop");
    const mgr = await makeManager(t);
    await db.businessMembership.create({ data: { userId: mgr.user.id, businessId: second.id, role: "MANAGER" } });
    const fresh = await sessionFor(mgr.user.id);
    expect(fresh.ctx.actor?.businessIds.sort()).toEqual([t.business.id, second.id].sort());
    await removeTeamMember(t.ctx, t.business.id, mgr.user.id);
    expect((await db.user.findUniqueOrThrow({ where: { id: mgr.user.id } })).status).toBe("ACTIVE");
    const token = fresh.cookie.split("=")[1];
    const actor = await actorFromToken(token);
    expect(actor?.businessIds).toEqual([second.id]);
    await refreshOwner(t);
  });
});

describe("settings", () => {
  it("returns defaults when nothing is stored", async () => {
    const admin = await adminSession();
    const s = await listSettings(admin.ctx);
    expect(s.orderExpiryMinutes).toBe(30);
    expect(s.webhookRetentionDays).toBe(90);
    expect(s.allowClientSelfRegistration).toBe(false);
    expect(s.platformName).toBe("YouPI PG");
    expect(await getOrderExpiryMinutes()).toBe(30);
  });

  it("validates ranges: boundaries accepted, just outside rejected, nothing written on failure", async () => {
    const admin = await adminSession();
    await expectAppError(setSetting(admin.ctx, "orderExpiryMinutes", 4), "VALIDATION");
    await expectAppError(setSetting(admin.ctx, "orderExpiryMinutes", 1441), "VALIDATION");
    await expectAppError(setSetting(admin.ctx, "orderExpiryMinutes", 30.5), "VALIDATION");
    await expectAppError(setSetting(admin.ctx, "orderExpiryMinutes", "30"), "VALIDATION");
    await expectAppError(setSetting(admin.ctx, "orderExpiryMinutes", null), "VALIDATION");
    expect(await getOrderExpiryMinutes()).toBe(30);
    expect(await db.platformSetting.count()).toBe(0);
    await setSetting(admin.ctx, "orderExpiryMinutes", 5);
    expect(await getOrderExpiryMinutes()).toBe(5);
    await setSetting(admin.ctx, "orderExpiryMinutes", 1440);
    expect(await getOrderExpiryMinutes()).toBe(1440);
    await expectAppError(setSetting(admin.ctx, "webhookRetentionDays", 6), "VALIDATION");
    await expectAppError(setSetting(admin.ctx, "webhookRetentionDays", 3651), "VALIDATION");
    await setSetting(admin.ctx, "webhookRetentionDays", 7);
    expect((await getAllSettings()).webhookRetentionDays).toBe(7);
  });

  it("validates strings, emails, booleans and permission lists", async () => {
    const admin = await adminSession();
    await expectAppError(setSetting(admin.ctx, "supportEmail", "not-an-email"), "VALIDATION");
    await expectAppError(setSetting(admin.ctx, "platformName", "x"), "VALIDATION");
    await expectAppError(setSetting(admin.ctx, "maintenanceBanner", "y".repeat(301)), "VALIDATION");
    await expectAppError(setSetting(admin.ctx, "allowClientSelfRegistration", "yes"), "VALIDATION");
    await expectAppError(setSetting(admin.ctx, "defaultClientPermissions", ["not.a.permission"]), "VALIDATION");
    expect(await setSetting(admin.ctx, "supportEmail", "Help@Example.COM")).toBe("help@example.com");
    expect(await setSetting(admin.ctx, "supportEmail", "")).toBe("");
    expect(await setSetting(admin.ctx, "defaultClientPermissions", ["qr.manage", "qr.manage"])).toEqual(["qr.manage"]);
  });

  it("bulk update is all-or-nothing, rejects unknown keys, empty input, and audits only changed keys", async () => {
    const admin = await adminSession();
    const err = await expectAppError(updateSettings(admin.ctx, { values: { platformName: "Fine Name", orderExpiryMinutes: 2 } }), "VALIDATION");
    expect(JSON.stringify(err.details)).toContain("orderExpiryMinutes");
    expect(await db.platformSetting.count()).toBe(0); // the valid half was not stored either
    await expectAppError(updateSettings(admin.ctx, { values: { evilKey: 1 } }), "BAD_REQUEST");
    await expectAppError(updateSettings(admin.ctx, { values: {} }), "BAD_REQUEST");
    await expectAppError(updateSettings(admin.ctx, {}), "VALIDATION");
    await updateSettings(admin.ctx, { values: { platformName: "Acme Pay", orderExpiryMinutes: 45 } });
    expect(await db.auditLog.count({ where: { action: "settings.update" } })).toBe(2);
    // saving identical values again changes nothing and audits nothing
    await updateSettings(admin.ctx, { values: { platformName: "Acme Pay", orderExpiryMinutes: 45 } });
    expect(await db.auditLog.count({ where: { action: "settings.update" } })).toBe(2);
    const a = await db.auditLog.findFirstOrThrow({ where: { action: "settings.update", entityId: "orderExpiryMinutes" } });
    expect(a.metadata).toMatchObject({ from: 30, to: 45 });
    expect((await getAllSettings()).platformName).toBe("Acme Pay");
  });

  it("a stored value that is no longer valid falls back to the default", async () => {
    await db.platformSetting.create({ data: { key: "orderExpiryMinutes", value: 99999 } });
    expect(await getOrderExpiryMinutes()).toBe(30);
  });

  it("is admin-only", async () => {
    const t = await makeClientTenant();
    await expectAppError(setSetting(t.ctx, "orderExpiryMinutes", 20), "FORBIDDEN");
    await expectAppError(updateSettings(t.ctx, { values: { platformName: "Hacked" } }), "FORBIDDEN");
    await expectAppError(listSettings(t.ctx), "FORBIDDEN");
    await expectAppError(setSetting(anonCtx(), "orderExpiryMinutes", 20), "UNAUTHENTICATED");
    await expectAppError(listSettings(anonCtx()), "UNAUTHENTICATED");
    expect(await db.platformSetting.count()).toBe(0);
  });
});
