import * as OTPAuth from "otpauth";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { actorFromToken } from "@/server/auth/session";
import { requireAdmin, requireClient } from "@/server/auth/guards";
import { hashPassword } from "@/server/auth/password";
import { changePassword, issueToken, login, logout, requestPasswordReset, setPasswordWithToken } from "@/server/services/auth";
import { anonCtx, makeAdmin, PASSWORD, resetDb } from "./helpers";

async function makeClientUser(email = "owner@shop.test") {
  const client = await db.client.create({ data: { clientCode: "CL-TEST0001", name: "Shop", contactName: "Owner", email, permissions: ["business.manage"] } });
  const user = await db.user.create({ data: { email, name: "Owner", role: "CLIENT", status: "ACTIVE", clientId: client.id, passwordHash: await hashPassword(PASSWORD) } });
  return { client, user };
}

beforeEach(async () => {
  await resetDb();
});

describe("login", () => {
  it("signs an admin in and the session resolves to an admin actor", async () => {
    await makeAdmin();
    const r = await login(anonCtx(), { email: "ADMIN@example.com", password: PASSWORD, portal: "admin" });
    expect(r.redirectTo).toBe("/admin");
    const actor = await actorFromToken(r.token);
    expect(actor?.role).toBe("SUPER_ADMIN");
    expect(() => requireAdmin({ actor, ip: null, userAgent: null })).not.toThrow();
    // the raw token is never stored
    const sessions = await db.session.findMany();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].tokenHash).not.toBe(r.token);
  });

  it("gives the same message for a wrong password and an unknown email", async () => {
    await makeAdmin();
    const wrong = await login(anonCtx(), { email: "admin@example.com", password: "Wrong-Password-1", portal: "admin" }).catch((e) => e);
    const unknown = await login(anonCtx(), { email: "nobody@example.com", password: "Wrong-Password-1", portal: "admin" }).catch((e) => e);
    expect(wrong.code).toBe("UNAUTHENTICATED");
    expect(unknown.code).toBe("UNAUTHENTICATED");
    expect(wrong.message).toBe(unknown.message);
  });

  it("does not reveal that an account exists when the wrong portal is used", async () => {
    await makeAdmin();
    const e = await login(anonCtx(), { email: "admin@example.com", password: PASSWORD, portal: "client" }).catch((x) => x);
    expect(e.code).toBe("UNAUTHENTICATED");
    expect(e.message).toBe("Incorrect email or password");
    expect(await db.session.count()).toBe(0);
  });

  it("locks the account after 5 failures, even for the right password", async () => {
    await makeAdmin();
    for (let i = 0; i < 5; i++) {
      await login(anonCtx(`198.51.100.${i}`), { email: "admin@example.com", password: "Wrong-Password-1", portal: "admin" }).catch(() => {});
    }
    const e = await login(anonCtx("198.51.100.99"), { email: "admin@example.com", password: PASSWORD, portal: "admin" }).catch((x) => x);
    expect(e.code).toBe("ACCOUNT_LOCKED");
  });

  it("rate limits repeated attempts from one address", async () => {
    let last: { code?: string } = {};
    for (let i = 0; i < 31; i++) {
      last = await login(anonCtx("192.0.2.1"), { email: `u${i}@example.com`, password: "x", portal: "admin" }).catch((e) => e);
    }
    expect(last.code).toBe("RATE_LIMITED");
  });

  it("refuses a suspended client account after proving the password", async () => {
    const { client } = await makeClientUser();
    await db.client.update({ where: { id: client.id }, data: { status: "SUSPENDED" } });
    const e = await login(anonCtx(), { email: "owner@shop.test", password: PASSWORD, portal: "client" }).catch((x) => x);
    expect(e.code).toBe("ACCOUNT_DISABLED");
  });

  it("client users cannot pass admin checks", async () => {
    await makeClientUser();
    const r = await login(anonCtx(), { email: "owner@shop.test", password: PASSWORD, portal: "client" });
    const actor = await actorFromToken(r.token);
    const ctx = { actor, ip: null, userAgent: null };
    expect(() => requireAdmin(ctx)).toThrow();
    expect(() => requireClient(ctx, "business.manage")).not.toThrow();
    expect(() => requireClient(ctx, "payments.refund")).toThrow(); // not granted
  });

  it("requires a valid TOTP code when 2FA is on", async () => {
    const admin = await makeAdmin();
    const secret = new OTPAuth.Secret({ size: 20 });
    await db.user.update({ where: { id: admin.id }, data: { totpEnabled: true, totpSecretEnc: encryptSecret(secret.base32) } });
    const missing = await login(anonCtx(), { email: "admin@example.com", password: PASSWORD, portal: "admin" }).catch((e) => e);
    expect(missing.code).toBe("TWO_FACTOR_REQUIRED");
    const bad = await login(anonCtx(), { email: "admin@example.com", password: PASSWORD, portal: "admin", totp: "000000" }).catch((e) => e);
    expect(bad.code).toBe("UNAUTHENTICATED");
    const code = new OTPAuth.TOTP({ secret, digits: 6, period: 30, algorithm: "SHA1" }).generate();
    const ok = await login(anonCtx(), { email: "admin@example.com", password: PASSWORD, portal: "admin", totp: code });
    expect(ok.token).toBeTruthy();
  });
});

describe("sessions", () => {
  it("logout revokes the session", async () => {
    await makeAdmin();
    const r = await login(anonCtx(), { email: "admin@example.com", password: PASSWORD, portal: "admin" });
    const actor = await actorFromToken(r.token);
    await logout({ actor, ip: null, userAgent: null });
    expect(await actorFromToken(r.token)).toBeNull();
  });

  it("expired sessions are rejected", async () => {
    await makeAdmin();
    const r = await login(anonCtx(), { email: "admin@example.com", password: PASSWORD, portal: "admin" });
    await db.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await actorFromToken(r.token)).toBeNull();
  });
});

describe("password reset", () => {
  it("answers the same for unknown emails and sends nothing", async () => {
    await makeAdmin();
    expect(await requestPasswordReset(anonCtx(), { email: "ghost@example.com" })).toEqual({ ok: true });
    expect(await requestPasswordReset(anonCtx(), { email: "admin@example.com" })).toEqual({ ok: true });
    expect(await db.authToken.count()).toBe(1);
  });

  it("a reset link works once, rejects weak passwords and signs out other sessions", async () => {
    const admin = await makeAdmin();
    const s = await login(anonCtx(), { email: "admin@example.com", password: PASSWORD, portal: "admin" });
    const { raw } = await issueToken(admin.id, "PASSWORD_RESET");
    const weak = await setPasswordWithToken(anonCtx(), { token: raw, password: "short" }).catch((e) => e);
    expect(weak.code).toBe("VALIDATION");
    await setPasswordWithToken(anonCtx(), { token: raw, password: "Brand-New-Passw0rd" });
    expect(await actorFromToken(s.token)).toBeNull();
    const again = await setPasswordWithToken(anonCtx(), { token: raw, password: "Another-Passw0rd-1" }).catch((e) => e);
    expect(again.code).toBe("BAD_REQUEST");
    const ok = await login(anonCtx(), { email: "admin@example.com", password: "Brand-New-Passw0rd", portal: "admin" });
    expect(ok.token).toBeTruthy();
  });

  it("an expired link is refused", async () => {
    const admin = await makeAdmin();
    const { raw } = await issueToken(admin.id, "PASSWORD_RESET");
    await db.authToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const e = await setPasswordWithToken(anonCtx(), { token: raw, password: "Brand-New-Passw0rd" }).catch((x) => x);
    expect(e.code).toBe("BAD_REQUEST");
  });

  it("changePassword needs the current password", async () => {
    await makeAdmin();
    const r = await login(anonCtx(), { email: "admin@example.com", password: PASSWORD, portal: "admin" });
    const ctx = { actor: await actorFromToken(r.token), ip: null, userAgent: null };
    const bad = await changePassword(ctx, { currentPassword: "nope-Nope-1", newPassword: "Brand-New-Passw0rd" }).catch((e) => e);
    expect(bad.code).toBeTruthy();
    await changePassword(ctx, { currentPassword: PASSWORD, newPassword: "Brand-New-Passw0rd" });
  });
});
