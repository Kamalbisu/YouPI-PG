import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { actorFromToken } from "@/server/auth/session";
import { login, setPasswordWithToken } from "@/server/services/auth";
import {
  clientLoginActivity,
  createClient,
  getClient,
  listClients,
  reactivateClient,
  resetClientPassword,
  suspendClient,
  updateClient,
  updateClientPermissions,
} from "@/server/services/clients";
import { getProfile, updateProfile } from "@/server/services/profile";
import { anonCtx, resetDb } from "./helpers";
import { adminSession, expectAppError, makeClientTenant, PASSWORD, sessionFor, tokenFromLink } from "./helpers-admin";

const NEW = { name: "Acme Traders", contactName: "Asha Rao", email: "Asha@Acme.test", phone: "+91 98765 43210", maxBusinesses: 2 };

beforeEach(async () => {
  await resetDb();
});

describe("create client and invite", () => {
  it("creates the client and an INVITED user, returns a one-time link, and the invite sets a password that can sign in", async () => {
    const { ctx } = await adminSession();
    const r = await createClient(ctx, NEW);
    expect(r.client.clientCode).toMatch(/^CL-/);
    expect(r.client.email).toBe("asha@acme.test"); // normalised
    expect(r.client.maxBusinesses).toBe(2);
    expect(r.user.email).toBe("asha@acme.test");
    const user = await db.user.findUniqueOrThrow({ where: { id: r.user.id } });
    expect(user.status).toBe("INVITED");
    expect(user.passwordHash).toBeNull();
    expect(user.role).toBe("CLIENT");
    expect(user.clientId).toBe(r.client.id);

    // The invited user cannot sign in before setting a password.
    const early = await login(anonCtx("203.0.113.9"), { email: "asha@acme.test", password: PASSWORD, portal: "client" }).catch((e) => e);
    expect(early.code).toBe("UNAUTHENTICATED");

    // The link carries a token that is stored only as a hash.
    const token = tokenFromLink(r.inviteLink);
    const stored = await db.authToken.findMany({ where: { userId: user.id } });
    expect(stored).toHaveLength(1);
    expect(stored[0].tokenHash).not.toBe(token);
    expect(stored[0].purpose).toBe("INVITE");

    const set = await setPasswordWithToken(anonCtx(), { token, password: PASSWORD });
    expect(set.role).toBe("CLIENT");
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).status).toBe("ACTIVE");

    const signedIn = await login(anonCtx("203.0.113.9"), { email: "asha@acme.test", password: PASSWORD, portal: "client" });
    expect(signedIn.redirectTo).toMatch(/^\/client/);

    // One-time: the same link cannot be used again.
    const again = await setPasswordWithToken(anonCtx(), { token, password: "Another-Passw0rd-1" }).catch((e) => e);
    expect(again.code).toBe("BAD_REQUEST");
  });

  it("applies the default permission list from settings when none are given, and honours an explicit list", async () => {
    const { ctx } = await adminSession();
    const a = await createClient(ctx, NEW);
    expect(a.client.permissions).toContain("support.use");
    const b = await createClient(ctx, { ...NEW, email: "b@acme.test", permissions: ["qr.manage", "qr.manage", "payments.view"] });
    expect([...b.client.permissions].sort()).toEqual(["payments.view", "qr.manage"]);
  });

  it("writes a client.create audit entry that holds no invite token", async () => {
    const { ctx, admin } = await adminSession();
    const r = await createClient(ctx, NEW);
    const rows = await db.auditLog.findMany({ where: { action: "client.create" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].actorId).toBe(admin.id);
    expect(rows[0].entityId).toBe(r.client.id);
    expect(rows[0].clientId).toBe(r.client.id);
    const everything = JSON.stringify(await db.auditLog.findMany());
    expect(everything).not.toContain(tokenFromLink(r.inviteLink));
  });

  it("rejects a duplicate login email with CONFLICT and creates nothing", async () => {
    const { ctx } = await adminSession();
    await createClient(ctx, NEW);
    const err = await expectAppError(createClient(ctx, { ...NEW, name: "Other Co", email: "ASHA@acme.test" }), "CONFLICT");
    expect(JSON.stringify(err.details)).toContain("email");
    expect(await db.client.count()).toBe(1);
    expect(await db.user.count({ where: { role: "CLIENT" } })).toBe(1);
    // An admin email is also taken.
    await expectAppError(createClient(ctx, { ...NEW, email: "admin@example.com" }), "CONFLICT");
  });

  it.each([
    ["bad email", { email: "not-an-email" }, "email"],
    ["name too short", { name: "A" }, "name"],
    ["missing contact name", { contactName: "" }, "contactName"],
    ["bad phone", { phone: "abc" }, "phone"],
    ["maxBusinesses zero", { maxBusinesses: 0 }, "maxBusinesses"],
    ["maxBusinesses above 100", { maxBusinesses: 101 }, "maxBusinesses"],
    ["maxBusinesses fractional", { maxBusinesses: 1.5 }, "maxBusinesses"],
    ["unknown permission", { permissions: ["products.manage", "god.mode"] }, "permissions"],
  ])("rejects bad input (%s) with VALIDATION and creates nothing", async (_n, patch, field) => {
    const { ctx } = await adminSession();
    const err = await expectAppError(createClient(ctx, { ...NEW, ...patch }), "VALIDATION");
    expect(Object.keys((err.details as { fields: object }).fields).join(" ")).toContain(field);
    expect(await db.client.count()).toBe(0);
    expect(await db.user.count({ where: { role: "CLIENT" } })).toBe(0);
  });

  it("is admin-only: anonymous gets 401, a client gets 403, and nothing is written", async () => {
    const t = await makeClientTenant();
    await expectAppError(createClient(anonCtx(), NEW), "UNAUTHENTICATED");
    await expectAppError(createClient(t.ctx, NEW), "FORBIDDEN");
    expect(await db.client.count()).toBe(1); // only the fixture
  });
});

describe("list, read and update", () => {
  it("lists with search, status filter and pagination, and ignores a bogus status", async () => {
    const { ctx } = await adminSession();
    for (let i = 1; i <= 3; i++) await createClient(ctx, { ...NEW, name: `Alpha ${i}`, email: `alpha${i}@x.test` });
    await createClient(ctx, { ...NEW, name: "Zulu Stores", email: "zulu@x.test" });
    expect((await listClients(ctx, {})).total).toBe(4);
    expect((await listClients(ctx, { q: "alpha" })).total).toBe(3);
    expect((await listClients(ctx, { q: "zulu@x" })).total).toBe(1);
    const p = await listClients(ctx, { page: "1", pageSize: "2" });
    expect(p.items).toHaveLength(2);
    expect(p.total).toBe(4);
    expect((await listClients(ctx, { status: "SUSPENDED" })).total).toBe(0);
    expect((await listClients(ctx, { status: "bogus" })).total).toBe(4);
    // a search containing quotes is parameterised, not interpolated
    expect((await listClients(ctx, { q: "x'; DROP TABLE \"Client\"; --" })).total).toBe(0);
    expect((await listClients(ctx, {})).total).toBe(4);
  });

  it("returns 404 for an unknown or malformed client id and 403 for a client caller", async () => {
    const { ctx } = await adminSession();
    const t = await makeClientTenant();
    await expectAppError(getClient(ctx, "does-not-exist"), "NOT_FOUND");
    await expectAppError(getClient(ctx, ""), "NOT_FOUND");
    await expectAppError(getClient(t.ctx, t.client.id), "FORBIDDEN");
    await expectAppError(listClients(t.ctx, {}), "FORBIDDEN");
    const full = await getClient(ctx, t.client.id);
    expect(full.users).toHaveLength(1);
    expect(full.businesses).toHaveLength(1);
    expect(full.suspension).toBeNull();
  });

  it("updates details and the business limit with an audit trail, and validates input", async () => {
    const { ctx } = await adminSession();
    const t = await makeClientTenant();
    const next = await updateClient(ctx, t.client.id, { name: "Renamed Co", contactName: "New Person", phone: "", address: "", notes: "vip", maxBusinesses: 7 });
    expect(next.name).toBe("Renamed Co");
    expect(next.maxBusinesses).toBe(7);
    expect(next.email).toBe(t.client.email); // login email is not editable here
    const a = await db.auditLog.findFirstOrThrow({ where: { action: "client.update" } });
    expect(a.entityId).toBe(t.client.id);
    await expectAppError(updateClient(ctx, t.client.id, { name: "X", contactName: "New Person", maxBusinesses: 7 }), "VALIDATION");
    await expectAppError(updateClient(ctx, t.client.id, { name: "Renamed Co", contactName: "New Person", maxBusinesses: 0 }), "VALIDATION");
    await expectAppError(updateClient(ctx, "nope", { name: "Renamed Co", contactName: "New Person", maxBusinesses: 2 }), "NOT_FOUND");
    expect((await db.client.findUniqueOrThrow({ where: { id: t.client.id } })).maxBusinesses).toBe(7);
  });

  it("replaces permissions (deduplicated), audits before and after, and rejects unknown ones", async () => {
    const { ctx } = await adminSession();
    const t = await makeClientTenant({ permissions: ["qr.manage"] });
    const r = await updateClientPermissions(ctx, t.client.id, { permissions: ["products.manage", "products.manage", "support.use"] });
    expect([...r.permissions].sort()).toEqual(["products.manage", "support.use"]);
    const a = await db.auditLog.findFirstOrThrow({ where: { action: "client.permissions" } });
    expect(a.metadata).toMatchObject({ from: ["qr.manage"], to: ["products.manage", "support.use"] });
    await expectAppError(updateClientPermissions(ctx, t.client.id, { permissions: ["nope"] }), "VALIDATION");
    await expectAppError(updateClientPermissions(ctx, t.client.id, {}), "VALIDATION");
    await expectAppError(updateClientPermissions(t.ctx, t.client.id, { permissions: [] }), "FORBIDDEN");
    // A fresh session reflects the new permission list immediately.
    const fresh = await sessionFor(t.owner.id);
    expect([...fresh.ctx.actor!.permissions].sort()).toEqual(["products.manage", "support.use"]);
  });
});

describe("suspend and reactivate", () => {
  it("revokes live sessions, blocks login with ACCOUNT_DISABLED, and records the reason", async () => {
    const { ctx } = await adminSession();
    const t = await makeClientTenant();
    const token = t.cookie.split("=")[1];
    expect((await actorFromToken(token))?.userId).toBe(t.owner.id);
    const other = await sessionFor(t.owner.id, "198.51.100.8");

    const c = await suspendClient(ctx, t.client.id, { reason: "Chargeback dispute" });
    expect(c.status).toBe("SUSPENDED");

    // existing sessions no longer resolve
    expect(await actorFromToken(token)).toBeNull();
    expect(await actorFromToken(other.cookie.split("=")[1])).toBeNull();
    expect(await db.session.count({ where: { userId: t.owner.id, revokedAt: null } })).toBe(0);

    // correct password still cannot sign in
    const err = await login(anonCtx("203.0.113.30"), { email: t.owner.email, password: PASSWORD, portal: "client" }).catch((e) => e);
    expect(err.code).toBe("ACCOUNT_DISABLED");
    const ev = await db.loginEvent.findFirst({ where: { userId: t.owner.id, success: false }, orderBy: { createdAt: "desc" } });
    expect(ev?.reason).toBe("disabled");

    const a = await db.auditLog.findFirstOrThrow({ where: { action: "client.suspend" } });
    expect(a.metadata).toMatchObject({ reason: "Chargeback dispute", from: "ACTIVE" });
    const detail = await getClient(ctx, t.client.id);
    expect(detail.suspension?.reason).toBe("Chargeback dispute");
  });

  it("requires a reason, refuses to suspend twice, and leaves the account active on bad input", async () => {
    const { ctx } = await adminSession();
    const t = await makeClientTenant();
    await expectAppError(suspendClient(ctx, t.client.id, {}), "VALIDATION");
    await expectAppError(suspendClient(ctx, t.client.id, { reason: "  " }), "VALIDATION");
    await expectAppError(suspendClient(ctx, t.client.id, { reason: "ab" }), "VALIDATION");
    expect((await db.client.findUniqueOrThrow({ where: { id: t.client.id } })).status).toBe("ACTIVE");
    expect(await actorFromToken(t.cookie.split("=")[1])).not.toBeNull(); // session untouched
    await suspendClient(ctx, t.client.id, { reason: "first suspension" });
    await expectAppError(suspendClient(ctx, t.client.id, { reason: "second suspension" }), "BAD_REQUEST");
    await expectAppError(suspendClient(ctx, "missing", { reason: "no such client" }), "NOT_FOUND");
    await expectAppError(suspendClient(t.ctx, t.client.id, { reason: "self suspend attempt" }), "FORBIDDEN");
    expect(await db.auditLog.count({ where: { action: "client.suspend" } })).toBe(1);
  });

  it("reactivation restores login; reactivating an active client is rejected", async () => {
    const { ctx } = await adminSession();
    const t = await makeClientTenant();
    await expectAppError(reactivateClient(ctx, t.client.id, {}), "BAD_REQUEST");
    await suspendClient(ctx, t.client.id, { reason: "temporary hold" });
    const c = await reactivateClient(ctx, t.client.id, { reason: "resolved" });
    expect(c.status).toBe("ACTIVE");
    const r = await login(anonCtx("203.0.113.31"), { email: t.owner.email, password: PASSWORD, portal: "client" });
    expect(r.redirectTo).toMatch(/^\/client/);
    expect(await db.auditLog.count({ where: { action: "client.reactivate" } })).toBe(1);
  });
});

describe("reset password and login activity", () => {
  it("issues a reset link, signs the user out everywhere, and the link sets a new password", async () => {
    const { ctx } = await adminSession();
    const t = await makeClientTenant();
    const r = await resetClientPassword(ctx, t.client.id, {});
    expect(r.purpose).toBe("PASSWORD_RESET");
    expect(await actorFromToken(t.cookie.split("=")[1])).toBeNull();
    await setPasswordWithToken(anonCtx(), { token: tokenFromLink(r.link), password: "Brand-New-Passw0rd" });
    const ok = await login(anonCtx("203.0.113.32"), { email: t.owner.email, password: "Brand-New-Passw0rd", portal: "client" });
    expect(ok.token).toBeTruthy();
    const a = await db.auditLog.findFirstOrThrow({ where: { action: "client.password_reset" } });
    expect(JSON.stringify(a.metadata)).not.toContain(tokenFromLink(r.link));
  });

  it("re-sends an invite for a user who never set a password and audits it as invite_resend", async () => {
    const { ctx } = await adminSession();
    const created = await createClient(ctx, NEW);
    const r = await resetClientPassword(ctx, created.client.id, {});
    expect(r.purpose).toBe("INVITE");
    expect(r.link).not.toBe(created.inviteLink);
    expect(await db.auditLog.count({ where: { action: "client.invite_resend" } })).toBe(1);
    await setPasswordWithToken(anonCtx(), { token: tokenFromLink(r.link), password: PASSWORD });
  });

  it("returns 404 for a user of another client, a missing client, and 403 to a client caller", async () => {
    const { ctx } = await adminSession();
    const a = await makeClientTenant();
    const b = await makeClientTenant();
    await expectAppError(resetClientPassword(ctx, a.client.id, { userId: b.owner.id }), "NOT_FOUND");
    await expectAppError(resetClientPassword(ctx, "missing", {}), "NOT_FOUND");
    await expectAppError(resetClientPassword(a.ctx, a.client.id, {}), "FORBIDDEN");
    expect(await actorFromToken(a.cookie.split("=")[1])).not.toBeNull(); // nothing was revoked by the failures
  });

  it("lists sign-in events for the client's users only", async () => {
    const { ctx } = await adminSession();
    const a = await makeClientTenant();
    const b = await makeClientTenant();
    await login(anonCtx("203.0.113.40"), { email: a.owner.email, password: PASSWORD, portal: "client" });
    await login(anonCtx("203.0.113.41"), { email: b.owner.email, password: PASSWORD, portal: "client" });
    await login(anonCtx("203.0.113.40"), { email: a.owner.email, password: "wrong-password-X1", portal: "client" }).catch(() => undefined);
    const page = await clientLoginActivity(ctx, a.client.id, {});
    expect(page.total).toBe(2);
    expect(page.items.every((e) => e.email === a.owner.email)).toBe(true);
    expect(page.items.some((e) => !e.success)).toBe(true);
    await expectAppError(clientLoginActivity(a.ctx, a.client.id, {}), "FORBIDDEN");
  });
});

describe("profile", () => {
  it("lets any signed-in user read and update their own name and phone, with an audit entry", async () => {
    const t = await makeClientTenant();
    const p = await getProfile(t.ctx);
    expect(p.user.email).toBe(t.owner.email);
    expect(p.isOwner).toBe(true);
    expect(JSON.stringify(p)).not.toMatch(/passwordHash|totpSecret/);
    const u = await updateProfile(t.ctx, { name: "New Name", phone: "+91 99999 11111" });
    expect(u.name).toBe("New Name");
    expect((await db.auditLog.findFirstOrThrow({ where: { action: "profile.update" } })).actorId).toBe(t.owner.id);
    // admins have a profile too
    const admin = await adminSession();
    expect((await updateProfile(admin.ctx, { name: "Admin Two", phone: "" })).name).toBe("Admin Two");
  });

  it("rejects bad input and anonymous callers, and never changes the email", async () => {
    const t = await makeClientTenant();
    await expectAppError(updateProfile(t.ctx, { name: "x", phone: "" }), "VALIDATION");
    await expectAppError(updateProfile(t.ctx, { name: "Fine Name", phone: "not a phone" }), "VALIDATION");
    await expectAppError(updateProfile(anonCtx(), { name: "Fine Name", phone: "" }), "UNAUTHENTICATED");
    await expectAppError(getProfile(anonCtx()), "UNAUTHENTICATED");
    await updateProfile(t.ctx, { name: "Fine Name", phone: "", email: "hacker@evil.test" });
    expect((await db.user.findUniqueOrThrow({ where: { id: t.owner.id } })).email).toBe(t.owner.email);
  });
});
