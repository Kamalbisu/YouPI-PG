import { randomBytes } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { enforceRateLimit } from "@/lib/rate-limit";
import { loginIdSchema, mobileSchema, nameSchema, otpCodeSchema, parse, passwordSchema, usernameSchema } from "@/lib/validation";
import { burnPasswordCheck, hashPassword, verifyPassword } from "@/server/auth/password";
import { createSession } from "@/server/auth/session";
import type { Ctx } from "@/server/auth/types";
import { requestOtp, verifyOtp } from "./otp";
import { maskPhone, recordActivity } from "./activity";

const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;
const BAD_LOGIN = "Wrong username or password";

type LoginRole = "ADMIN" | "USER" | "AUDITOR";

export interface LoginResult {
  token: string;
  role: LoginRole;
}

async function startSession(ctx: Ctx, userId: string, role: LoginRole, method: string): Promise<LoginResult> {
  const { token } = await createSession(userId, { ip: ctx.ip, userAgent: ctx.userAgent });
  const u = await db.user.update({
    where: { id: userId },
    data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null },
    select: { name: true, username: true },
  });
  await audit({ ...ctx, actor: { userId, role, name: u.name, username: u.username, sessionId: null } }, { action: `auth.login.${role.toLowerCase()}`, entityType: "User", entityId: userId, metadata: { method } });
  await recordActivity(
    ctx,
    { type: "auth.login.success", actor: { type: role, id: userId, name: u.username }, targetUserId: userId, metadata: { role, method } },
  );
  return { token, role };
}

/** Shared password check with throttling and lockout. Only accounts of `role` can sign in here. */
async function passwordLogin(ctx: Ctx, role: LoginRole, identifier: string, password: string, field: "username" | "email"): Promise<LoginResult> {
  const scope = role.toLowerCase();
  await enforceRateLimit(`login:${scope}:ip:${ctx.ip ?? "unknown"}`, 20, 900, "Too many attempts. Please try again in a few minutes.");
  await enforceRateLimit(`login:${scope}:id:${identifier}`, 10, 900, "Too many attempts. Please try again in a few minutes.");

  const user = await db.user.findFirst({
    where: { role, ...(field === "email" ? { OR: [{ email: identifier }, { username: identifier }] } : { username: identifier }) },
  });
  const failedEvent = (reason: string, u?: { id: string; username: string } | null) =>
    recordActivity(ctx, {
      type: "auth.login.failed",
      actor: { type: "SYSTEM" },
      targetUserId: u?.id ?? null,
      metadata: { role, identifier: identifier.slice(0, 60), reason },
    });
  if (!user || !user.passwordHash) {
    await burnPasswordCheck(password);
    await failedEvent("unknown account");
    throw new AppError("UNAUTHENTICATED", BAD_LOGIN);
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await failedEvent("account locked", user);
    throw new AppError("ACCOUNT_LOCKED", "Too many wrong attempts. Try again in 15 minutes.");
  }
  const ok = await verifyPassword(user.passwordHash, password);
  if (!ok) {
    const failed = user.failedLoginCount + 1;
    await db.user.update({
      where: { id: user.id },
      data: failed >= MAX_FAILED ? { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCK_MS) } : { failedLoginCount: failed },
    });
    await failedEvent("wrong password", user);
    throw new AppError("UNAUTHENTICATED", BAD_LOGIN);
  }
  if (user.status !== "ACTIVE") {
    await failedEvent("account disabled", user);
    throw new AppError("ACCOUNT_DISABLED", "This account has been disabled. Contact the administrator.");
  }
  return startSession(ctx, user.id, role, "password");
}

export async function adminLogin(ctx: Ctx, input: unknown): Promise<LoginResult> {
  const { login, password } = parse(z.object({ login: loginIdSchema, password: z.string().min(1).max(200) }), input);
  return passwordLogin(ctx, "ADMIN", login, password, "email");
}

export async function auditorLogin(ctx: Ctx, input: unknown): Promise<LoginResult> {
  const { login, password } = parse(z.object({ login: loginIdSchema, password: z.string().min(1).max(200) }), input);
  return passwordLogin(ctx, "AUDITOR", login, password, "email");
}

export async function userLogin(ctx: Ctx, input: unknown): Promise<LoginResult> {
  const { username, password } = parse(z.object({ username: loginIdSchema, password: z.string().min(1).max(200) }), input);
  return passwordLogin(ctx, "USER", username, password, "username");
}

// ---------- signup: username + password, mobile verified by SMS ----------

/** Step 1: validate the details and SMS a code. The account is created only after the code is verified. */
export async function signupStart(ctx: Ctx, input: unknown) {
  const d = parse(
    z.object({ name: nameSchema, username: usernameSchema, mobile: mobileSchema, password: passwordSchema }),
    input,
  );
  const [byName, byMobile] = await Promise.all([
    db.user.findUnique({ where: { username: d.username }, select: { id: true } }),
    db.user.findUnique({ where: { mobile: d.mobile }, select: { id: true } }),
  ]);
  if (byName) throw new AppError("CONFLICT", "That username is taken. Choose another.", { fields: { username: "Username is taken" } });
  if (byMobile) {
    throw new AppError("CONFLICT", "This number cannot be used for a new account. If it is yours, sign in instead.", {
      fields: { mobile: "Cannot be used for a new account" },
    });
  }
  const passwordHash = await hashPassword(d.password);
  const r = await requestOtp(ctx, { phone: d.mobile, purpose: "SIGNUP", payload: { name: d.name, username: d.username, passwordHash } });
  await recordActivity(ctx, { type: "auth.signup.started", actor: { type: "USER", name: d.username }, metadata: { username: d.username, phone: maskPhone(d.mobile) } });
  return { mobile: d.mobile, ...r };
}

/** Step 2: verify the code, create the account and sign in. */
export async function signupVerify(ctx: Ctx, input: unknown): Promise<LoginResult> {
  const { mobile, code } = parse(z.object({ mobile: mobileSchema, code: otpCodeSchema }), input);
  const { payload } = await verifyOtp(ctx, { phone: mobile, purpose: "SIGNUP", code });
  const p = payload as { name?: string; username?: string; passwordHash?: string } | null;
  if (!p?.name || !p.username || !p.passwordHash) throw new AppError("BAD_REQUEST", "Signup details expired. Start again.");
  let userId: string;
  try {
    const u = await db.user.create({
      data: { role: "USER", name: p.name, username: p.username, mobile, passwordHash: p.passwordHash, mobileVerifiedAt: new Date() },
      select: { id: true },
    });
    userId = u.id;
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") throw new AppError("CONFLICT", "That username or number was just taken. Start again.");
    throw e;
  }
  await audit({ ...ctx, actor: null }, { action: "user.signup", entityType: "User", entityId: userId, metadata: { method: "password" } });
  await recordActivity(ctx, { type: "auth.signup.verified", actor: { type: "USER", id: userId, name: p.username }, targetUserId: userId, metadata: { method: "password", phone: maskPhone(mobile) } });
  return startSession(ctx, userId, "USER", "signup");
}

// ---------- OTP login (also creates the account for a new number) ----------

export async function otpLoginStart(ctx: Ctx, input: unknown) {
  const { mobile } = parse(z.object({ mobile: mobileSchema }), input);
  const r = await requestOtp(ctx, { phone: mobile, purpose: "LOGIN" });
  // Same answer whether or not the number is registered.
  return { mobile, ...r };
}

function generatedUsername(): string {
  return `user_${randomBytes(5).toString("hex")}`;
}

export async function otpLoginVerify(ctx: Ctx, input: unknown): Promise<LoginResult & { created: boolean }> {
  const { mobile, code, name } = parse(
    z.object({ mobile: mobileSchema, code: otpCodeSchema, name: z.union([nameSchema, z.literal("")]).optional() }),
    input,
  );
  await verifyOtp(ctx, { phone: mobile, purpose: "LOGIN", code });

  let user = await db.user.findUnique({ where: { mobile }, select: { id: true, role: true, status: true } });
  let created = false;
  if (!user) {
    for (let i = 0; i < 5 && !user; i++) {
      try {
        user = await db.user.create({
          data: {
            role: "USER",
            name: name || `User ${mobile.slice(-4)}`,
            username: generatedUsername(),
            mobile,
            mobileVerifiedAt: new Date(),
          },
          select: { id: true, role: true, status: true },
        });
        created = true;
      } catch (e) {
        if ((e as { code?: string }).code !== "P2002") throw e;
        user = await db.user.findUnique({ where: { mobile }, select: { id: true, role: true, status: true } });
      }
    }
    if (!user) throw new AppError("INTERNAL", "Could not create the account. Please try again.");
    await audit({ ...ctx, actor: null }, { action: "user.signup", entityType: "User", entityId: user.id, metadata: { method: "otp" } });
    await recordActivity(ctx, { type: "auth.signup.verified", actor: { type: "USER", id: user.id }, targetUserId: user.id, metadata: { method: "otp", phone: maskPhone(mobile) } });
  }
  if (user.role !== "USER") throw new AppError("FORBIDDEN", "This number cannot sign in here.");
  if (user.status !== "ACTIVE") throw new AppError("ACCOUNT_DISABLED", "This account has been disabled. Contact the administrator.");
  const r = await startSession(ctx, user.id, "USER", "otp");
  return { ...r, created };
}
