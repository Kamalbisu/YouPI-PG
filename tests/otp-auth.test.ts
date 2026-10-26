import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { OTP_MAX_ATTEMPTS, requestOtp, verifyOtp } from "@/server/services/otp";
import { adminLogin, otpLoginStart, otpLoginVerify, signupStart, signupVerify, userLogin } from "@/server/services/auth";
import { actorFromToken } from "@/server/auth/session";
import { PASSWORD, anonCtx, codeFrom, makeAdmin, makeUser, resetDb } from "./helpers";

const sms = vi.hoisted(() => ({ sent: [] as { to: string; content: string }[] }));
vi.mock("@/server/services/sms", () => ({
  sendSms: async (to: string, content: string) => {
    sms.sent.push({ to, content });
  },
}));

const lastCode = () => codeFrom(sms.sent[sms.sent.length - 1]!.content);
const MOBILE = "9876543210";
const E164 = "+919876543210";

/** Make the cooldown pass without waiting 45 seconds. */
const skipCooldown = () => db.otpCode.updateMany({ data: { createdAt: new Date(Date.now() - 120_000) } });

beforeEach(async () => {
  await resetDb();
  sms.sent.length = 0;
});

describe("OTP rules", () => {
  it("sends a 6 digit code to the normalised number", async () => {
    await requestOtp(anonCtx(), { phone: E164, purpose: "LOGIN" });
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]!.to).toBe(E164);
    expect(lastCode()).toMatch(/^\d{6}$/);
  });

  it("accepts the right code once and never again (single use)", async () => {
    await requestOtp(anonCtx(), { phone: E164, purpose: "LOGIN" });
    const code = lastCode();
    await expect(verifyOtp(anonCtx(), { phone: E164, purpose: "LOGIN", code })).resolves.toBeTruthy();
    await expect(verifyOtp(anonCtx(), { phone: E164, purpose: "LOGIN", code })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects a wrong code", async () => {
    await requestOtp(anonCtx(), { phone: E164, purpose: "LOGIN" });
    const wrong = lastCode() === "000000" ? "111111" : "000000";
    await expect(verifyOtp(anonCtx(), { phone: E164, purpose: "LOGIN", code: wrong })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects an expired code", async () => {
    await requestOtp(anonCtx(), { phone: E164, purpose: "LOGIN" });
    const code = lastCode();
    await db.otpCode.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(verifyOtp(anonCtx(), { phone: E164, purpose: "LOGIN", code })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("burns the code after too many wrong tries, even if the right one is then entered", async () => {
    await requestOtp(anonCtx(), { phone: E164, purpose: "LOGIN" });
    const right = lastCode();
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) {
      await expect(verifyOtp(anonCtx(), { phone: E164, purpose: "LOGIN", code: wrong })).rejects.toBeTruthy();
    }
    await expect(verifyOtp(anonCtx(), { phone: E164, purpose: "LOGIN", code: right })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("enforces the resend cooldown", async () => {
    await requestOtp(anonCtx(), { phone: E164, purpose: "LOGIN" });
    await expect(requestOtp(anonCtx(), { phone: E164, purpose: "LOGIN" })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(sms.sent).toHaveLength(1);
    await skipCooldown();
    await requestOtp(anonCtx(), { phone: E164, purpose: "LOGIN" });
    expect(sms.sent).toHaveLength(2);
  });

  it("a newer code replaces the older one", async () => {
    await requestOtp(anonCtx(), { phone: E164, purpose: "LOGIN" });
    const first = lastCode();
    await skipCooldown();
    await requestOtp(anonCtx(), { phone: E164, purpose: "LOGIN" });
    const second = lastCode();
    if (first !== second) {
      await expect(verifyOtp(anonCtx(), { phone: E164, purpose: "LOGIN", code: first })).rejects.toBeTruthy();
    }
    await expect(verifyOtp(anonCtx(), { phone: E164, purpose: "LOGIN", code: second })).resolves.toBeTruthy();
  });

  it("a login code cannot be used for signup", async () => {
    await requestOtp(anonCtx(), { phone: E164, purpose: "LOGIN" });
    await expect(verifyOtp(anonCtx(), { phone: E164, purpose: "SIGNUP", code: lastCode() })).rejects.toBeTruthy();
  });

  it("limits code requests per IP", async () => {
    const ctx = anonCtx("198.51.100.7");
    for (let i = 0; i < 20; i++) {
      await requestOtp(ctx, { phone: `+9190000${String(10000 + i)}`, purpose: "LOGIN" });
    }
    await expect(requestOtp(ctx, { phone: "+919111111111", purpose: "LOGIN" })).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});

describe("signup with username + password (mobile verified by OTP)", () => {
  const details = { name: "Asha Rao", username: "Asha_R", mobile: MOBILE, password: PASSWORD };

  it("creates the account only after the code is verified, then signs in", async () => {
    const r = await signupStart(anonCtx(), details);
    expect(r.mobile).toBe(E164);
    expect(await db.user.count({ where: { role: "USER" } })).toBe(0);

    const login = await signupVerify(anonCtx(), { mobile: MOBILE, code: lastCode() });
    expect(login.role).toBe("USER");
    const actor = await actorFromToken(login.token);
    expect(actor).toMatchObject({ role: "USER", username: "asha_r" });
    const u = await db.user.findUnique({ where: { username: "asha_r" } });
    expect(u?.mobile).toBe(E164);
    expect(u?.mobileVerifiedAt).toBeTruthy();
    expect(u?.passwordHash).not.toContain(PASSWORD);
  });

  it("then the new user can log in with username and password", async () => {
    await signupStart(anonCtx(), details);
    await signupVerify(anonCtx(), { mobile: MOBILE, code: lastCode() });
    const r = await userLogin(anonCtx("198.51.100.1"), { username: "ASHA_R", password: PASSWORD });
    expect(r.role).toBe("USER");
  });

  it("requires a mobile number", async () => {
    await expect(signupStart(anonCtx(), { ...details, mobile: "" })).rejects.toBeTruthy();
    expect(sms.sent).toHaveLength(0);
  });

  it("rejects a weak password and a bad username", async () => {
    await expect(signupStart(anonCtx(), { ...details, password: "short" })).rejects.toBeTruthy();
    await expect(signupStart(anonCtx(), { ...details, username: "a b" })).rejects.toBeTruthy();
  });

  it("rejects a taken username and a taken number", async () => {
    await makeUser("taken", E164);
    await expect(signupStart(anonCtx(), { ...details, username: "taken", mobile: "9123456780" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(signupStart(anonCtx(), details)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("does not create the account with a wrong code", async () => {
    await signupStart(anonCtx(), details);
    const wrong = lastCode() === "123456" ? "654321" : "123456";
    await expect(signupVerify(anonCtx(), { mobile: MOBILE, code: wrong })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await db.user.count({ where: { role: "USER" } })).toBe(0);
  });
});

describe("login with SMS code", () => {
  it("signs in an existing user", async () => {
    const u = await makeUser("rita", E164);
    await otpLoginStart(anonCtx(), { mobile: MOBILE });
    const r = await otpLoginVerify(anonCtx(), { mobile: MOBILE, code: lastCode() });
    expect(r.created).toBe(false);
    expect((await actorFromToken(r.token))?.userId).toBe(u.id);
  });

  it("creates the account for a new number", async () => {
    await otpLoginStart(anonCtx(), { mobile: MOBILE });
    const r = await otpLoginVerify(anonCtx(), { mobile: MOBILE, code: lastCode(), name: "New Person" });
    expect(r.created).toBe(true);
    const u = await db.user.findUnique({ where: { mobile: E164 } });
    expect(u).toMatchObject({ role: "USER", name: "New Person", status: "ACTIVE" });
    expect(u?.username).toMatch(/^user_[0-9a-f]{10}$/);
    expect((await actorFromToken(r.token))?.role).toBe("USER");
  });

  it("gives the same answer for registered and unknown numbers", async () => {
    await makeUser("known", E164);
    const a = await otpLoginStart(anonCtx(), { mobile: MOBILE });
    const b = await otpLoginStart(anonCtx("198.51.100.2"), { mobile: "9123456780" });
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
  });

  it("refuses a disabled user", async () => {
    const u = await makeUser("off", E164);
    await db.user.update({ where: { id: u.id }, data: { status: "DISABLED" } });
    await otpLoginStart(anonCtx(), { mobile: MOBILE });
    await expect(otpLoginVerify(anonCtx(), { mobile: MOBILE, code: lastCode() })).rejects.toMatchObject({ code: "ACCOUNT_DISABLED" });
  });

  it("does not let an admin's number sign in through the user flow", async () => {
    const a = await makeAdmin();
    await db.user.update({ where: { id: a.id }, data: { mobile: E164 } });
    await otpLoginStart(anonCtx(), { mobile: MOBILE });
    await expect(otpLoginVerify(anonCtx(), { mobile: MOBILE, code: lastCode() })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("password login", () => {
  it("user login rejects wrong passwords with one generic message", async () => {
    await makeUser("lena");
    const bad = await userLogin(anonCtx(), { username: "lena", password: "Wrong-Password-1" }).catch((e) => e);
    const none = await userLogin(anonCtx(), { username: "nobody", password: "Wrong-Password-1" }).catch((e) => e);
    expect(bad.code).toBe("UNAUTHENTICATED");
    expect(bad.message).toBe(none.message);
  });

  it("locks the account after repeated failures", async () => {
    await makeUser("lock");
    for (let i = 0; i < 5; i++) await userLogin(anonCtx(), { username: "lock", password: "Wrong-Password-1" }).catch(() => {});
    await expect(userLogin(anonCtx(), { username: "lock", password: PASSWORD })).rejects.toMatchObject({ code: "ACCOUNT_LOCKED" });
  });

  it("admins sign in with email or username, only via the admin login", async () => {
    await makeAdmin("boss@example.com");
    await expect(adminLogin(anonCtx(), { login: "boss@example.com", password: PASSWORD })).resolves.toMatchObject({ role: "ADMIN" });
    await expect(adminLogin(anonCtx(), { login: "admin", password: PASSWORD })).resolves.toMatchObject({ role: "ADMIN" });
    // an admin account is invisible to the user login, and vice versa
    await expect(userLogin(anonCtx(), { username: "admin", password: PASSWORD })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await makeUser("normal");
    await expect(adminLogin(anonCtx(), { login: "normal", password: PASSWORD })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("a disabled user cannot sign in, and existing sessions stop working", async () => {
    const u = await makeUser("gone");
    const { token } = await userLogin(anonCtx(), { username: "gone", password: PASSWORD });
    expect(await actorFromToken(token)).toBeTruthy();
    await db.user.update({ where: { id: u.id }, data: { status: "DISABLED" } });
    expect(await actorFromToken(token)).toBeNull();
    await expect(userLogin(anonCtx(), { username: "gone", password: PASSWORD })).rejects.toMatchObject({ code: "ACCOUNT_DISABLED" });
  });
});
