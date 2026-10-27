import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { OTP_MAX_ATTEMPTS, requestOtp, verifyOtp } from "@/server/services/otp";
import { adminLogin, otpLoginStart, otpLoginVerify, signupStart, signupVerify, userLogin } from "@/server/services/auth";
import { actorFromToken } from "@/server/auth/session";
import { PASSWORD, anonCtx, codeFrom, makeAdmin, makeUser, resetDb } from "./helpers";

const mail = vi.hoisted(() => ({ sent: [] as { to: string; subject: string; text: string }[] }));
vi.mock("@/server/services/mailer", () => ({
  sendEmail: async (to: string, m: { subject: string; text: string }) => {
    mail.sent.push({ to, ...m });
  },
}));

const lastCode = () => codeFrom(mail.sent[mail.sent.length - 1]!.text);
const EMAIL = "asha@example.com";

/** Make the cooldown pass without waiting 45 seconds. */
const skipCooldown = () => db.otpCode.updateMany({ data: { createdAt: new Date(Date.now() - 120_000) } });

beforeEach(async () => {
  await resetDb();
  mail.sent.length = 0;
});

describe("OTP rules", () => {
  it("emails a 6 digit code to the address", async () => {
    await requestOtp(anonCtx(), { email: EMAIL, purpose: "LOGIN" });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.to).toBe(EMAIL);
    expect(lastCode()).toMatch(/^\d{6}$/);
  });

  it("accepts the right code once and never again (single use)", async () => {
    await requestOtp(anonCtx(), { email: EMAIL, purpose: "LOGIN" });
    const code = lastCode();
    await expect(verifyOtp(anonCtx(), { email: EMAIL, purpose: "LOGIN", code })).resolves.toBeTruthy();
    await expect(verifyOtp(anonCtx(), { email: EMAIL, purpose: "LOGIN", code })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects a wrong code", async () => {
    await requestOtp(anonCtx(), { email: EMAIL, purpose: "LOGIN" });
    const wrong = lastCode() === "000000" ? "111111" : "000000";
    await expect(verifyOtp(anonCtx(), { email: EMAIL, purpose: "LOGIN", code: wrong })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects an expired code", async () => {
    await requestOtp(anonCtx(), { email: EMAIL, purpose: "LOGIN" });
    const code = lastCode();
    await db.otpCode.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(verifyOtp(anonCtx(), { email: EMAIL, purpose: "LOGIN", code })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("burns the code after too many wrong tries, even if the right one is then entered", async () => {
    await requestOtp(anonCtx(), { email: EMAIL, purpose: "LOGIN" });
    const right = lastCode();
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) {
      await expect(verifyOtp(anonCtx(), { email: EMAIL, purpose: "LOGIN", code: wrong })).rejects.toBeTruthy();
    }
    await expect(verifyOtp(anonCtx(), { email: EMAIL, purpose: "LOGIN", code: right })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("enforces the resend cooldown", async () => {
    await requestOtp(anonCtx(), { email: EMAIL, purpose: "LOGIN" });
    await expect(requestOtp(anonCtx(), { email: EMAIL, purpose: "LOGIN" })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(mail.sent).toHaveLength(1);
    await skipCooldown();
    await requestOtp(anonCtx(), { email: EMAIL, purpose: "LOGIN" });
    expect(mail.sent).toHaveLength(2);
  });

  it("a newer code replaces the older one", async () => {
    await requestOtp(anonCtx(), { email: EMAIL, purpose: "LOGIN" });
    const first = lastCode();
    await skipCooldown();
    await requestOtp(anonCtx(), { email: EMAIL, purpose: "LOGIN" });
    const second = lastCode();
    if (first !== second) {
      await expect(verifyOtp(anonCtx(), { email: EMAIL, purpose: "LOGIN", code: first })).rejects.toBeTruthy();
    }
    await expect(verifyOtp(anonCtx(), { email: EMAIL, purpose: "LOGIN", code: second })).resolves.toBeTruthy();
  });

  it("a login code cannot be used for signup", async () => {
    await requestOtp(anonCtx(), { email: EMAIL, purpose: "LOGIN" });
    await expect(verifyOtp(anonCtx(), { email: EMAIL, purpose: "SIGNUP", code: lastCode() })).rejects.toBeTruthy();
  });

  it("limits code requests per IP", async () => {
    const ctx = anonCtx("198.51.100.7");
    for (let i = 0; i < 20; i++) {
      await requestOtp(ctx, { email: `person${i}@example.com`, purpose: "LOGIN" });
    }
    await expect(requestOtp(ctx, { email: "extra@example.com", purpose: "LOGIN" })).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});

describe("signup with username + password (email verified by OTP)", () => {
  const details = { name: "Asha Rao", username: "Asha_R", email: EMAIL, password: PASSWORD };

  it("creates the account only after the code is verified, then signs in", async () => {
    const r = await signupStart(anonCtx(), details);
    expect(r.email).toBe(EMAIL);
    expect(await db.user.count({ where: { role: "USER" } })).toBe(0);

    const login = await signupVerify(anonCtx(), { email: EMAIL, code: lastCode() });
    expect(login.role).toBe("USER");
    const actor = await actorFromToken(login.token);
    expect(actor).toMatchObject({ role: "USER", username: "asha_r" });
    const u = await db.user.findUnique({ where: { username: "asha_r" } });
    expect(u?.email).toBe(EMAIL);
    expect(u?.emailVerifiedAt).toBeTruthy();
    expect(u?.passwordHash).not.toContain(PASSWORD);
  });

  it("then the new user can log in with username and password", async () => {
    await signupStart(anonCtx(), details);
    await signupVerify(anonCtx(), { email: EMAIL, code: lastCode() });
    const r = await userLogin(anonCtx("198.51.100.1"), { username: "ASHA_R", password: PASSWORD });
    expect(r.role).toBe("USER");
  });

  it("requires a valid email", async () => {
    await expect(signupStart(anonCtx(), { ...details, email: "not-an-email" })).rejects.toBeTruthy();
    expect(mail.sent).toHaveLength(0);
  });

  it("rejects a weak password and a bad username", async () => {
    await expect(signupStart(anonCtx(), { ...details, password: "short" })).rejects.toBeTruthy();
    await expect(signupStart(anonCtx(), { ...details, username: "a b" })).rejects.toBeTruthy();
  });

  it("rejects a taken username and a taken email", async () => {
    await makeUser("taken", undefined, EMAIL);
    await expect(signupStart(anonCtx(), { ...details, username: "taken", email: "other@example.com" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(signupStart(anonCtx(), details)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("does not create the account with a wrong code", async () => {
    await signupStart(anonCtx(), details);
    const wrong = lastCode() === "123456" ? "654321" : "123456";
    await expect(signupVerify(anonCtx(), { email: EMAIL, code: wrong })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await db.user.count({ where: { role: "USER" } })).toBe(0);
  });
});

describe("login with email code", () => {
  it("signs in an existing user", async () => {
    const u = await makeUser("rita", undefined, EMAIL);
    await otpLoginStart(anonCtx(), { email: EMAIL });
    const r = await otpLoginVerify(anonCtx(), { email: EMAIL, code: lastCode() });
    expect(r.created).toBe(false);
    expect((await actorFromToken(r.token))?.userId).toBe(u.id);
  });

  it("creates the account for a new email", async () => {
    await otpLoginStart(anonCtx(), { email: EMAIL });
    const r = await otpLoginVerify(anonCtx(), { email: EMAIL, code: lastCode(), name: "New Person" });
    expect(r.created).toBe(true);
    const u = await db.user.findUnique({ where: { email: EMAIL } });
    expect(u).toMatchObject({ role: "USER", name: "New Person", status: "ACTIVE" });
    expect(u?.username).toMatch(/^user_[0-9a-f]{10}$/);
    expect((await actorFromToken(r.token))?.role).toBe("USER");
  });

  it("gives the same answer for registered and unknown emails", async () => {
    await makeUser("known", undefined, EMAIL);
    const a = await otpLoginStart(anonCtx(), { email: EMAIL });
    const b = await otpLoginStart(anonCtx("198.51.100.2"), { email: "other@example.com" });
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
  });

  it("refuses a disabled user", async () => {
    const u = await makeUser("off", undefined, EMAIL);
    await db.user.update({ where: { id: u.id }, data: { status: "DISABLED" } });
    await otpLoginStart(anonCtx(), { email: EMAIL });
    await expect(otpLoginVerify(anonCtx(), { email: EMAIL, code: lastCode() })).rejects.toMatchObject({ code: "ACCOUNT_DISABLED" });
  });

  it("does not let an admin's email sign in through the user flow", async () => {
    await makeAdmin(EMAIL);
    await otpLoginStart(anonCtx(), { email: EMAIL });
    await expect(otpLoginVerify(anonCtx(), { email: EMAIL, code: lastCode() })).rejects.toMatchObject({ code: "FORBIDDEN" });
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
