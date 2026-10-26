import * as OTPAuth from "otpauth";
import { z } from "zod";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { AppError, badRequest } from "@/lib/errors";
import { randomToken } from "@/lib/ids";
import { sha256Hex, decryptSecret, encryptSecret } from "@/lib/crypto";
import { emailSchema, parse, passwordSchema } from "@/lib/validation";
import { enforceRateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { burnPasswordCheck, hashPassword, verifyPassword } from "../auth/password";
import { createSession, revokeAllSessions } from "../auth/session";
import { requireActor } from "../auth/guards";
import type { Ctx } from "../auth/types";
import { notify } from "./notifications";

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const GENERIC_FAIL = "Incorrect email or password";

export const loginInput = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
  portal: z.enum(["admin", "client"]),
  totp: z.string().trim().regex(/^[0-9]{6}$/).optional(),
});

export type LoginResult = { token: string; role: "SUPER_ADMIN" | "CLIENT"; redirectTo: string };

async function logEvent(ctx: Ctx, email: string, success: boolean, portal: string, userId?: string, reason?: string) {
  await db.loginEvent.create({
    data: { email, success, portal, userId, reason, ip: ctx.ip, userAgent: ctx.userAgent?.slice(0, 300) },
  });
}

export async function login(ctx: Ctx, raw: unknown): Promise<LoginResult> {
  const input = parse(loginInput, raw);
  const ipKey = ctx.ip ?? "unknown";
  await enforceRateLimit(`login:ip:${ipKey}`, 30, 15 * 60, "Too many sign-in attempts. Try again in a few minutes.");
  await enforceRateLimit(`login:email:${input.email}`, 10, 15 * 60, "Too many sign-in attempts. Try again in a few minutes.");

  const user = await db.user.findUnique({ where: { email: input.email }, include: { client: true } });
  if (!user || !user.passwordHash) {
    await burnPasswordCheck(input.password);
    await logEvent(ctx, input.email, false, input.portal, undefined, "unknown_user");
    throw new AppError("UNAUTHENTICATED", GENERIC_FAIL);
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await logEvent(ctx, input.email, false, input.portal, user.id, "locked");
    throw new AppError("ACCOUNT_LOCKED", "Too many failed attempts. Try again in 15 minutes or reset your password.");
  }
  const ok = await verifyPassword(user.passwordHash, input.password);
  if (!ok) {
    const fails = user.failedLoginCount + 1;
    await db.user.update({
      where: { id: user.id },
      data: { failedLoginCount: fails, lockedUntil: fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MS) : null },
    });
    await logEvent(ctx, input.email, false, input.portal, user.id, "bad_password");
    if (fails >= MAX_FAILS) await audit({ ...ctx, actor: null }, { action: "auth.locked", entityType: "User", entityId: user.id, clientId: user.clientId });
    throw new AppError("UNAUTHENTICATED", GENERIC_FAIL);
  }
  // Correct password from here. Distinguish states, but only after proving the password.
  const portalOk = (input.portal === "admin") === (user.role === "SUPER_ADMIN");
  if (!portalOk) {
    await logEvent(ctx, input.email, false, input.portal, user.id, "wrong_portal");
    throw new AppError("UNAUTHENTICATED", GENERIC_FAIL);
  }
  if (user.status !== "ACTIVE" || (user.role === "CLIENT" && user.client?.status !== "ACTIVE")) {
    await logEvent(ctx, input.email, false, input.portal, user.id, "disabled");
    throw new AppError("ACCOUNT_DISABLED", "This account is disabled. Contact the platform administrator.");
  }
  if (user.totpEnabled && user.totpSecretEnc) {
    if (!input.totp) throw new AppError("TWO_FACTOR_REQUIRED", "Enter the 6-digit code from your authenticator app");
    await enforceRateLimit(`totp:${user.id}`, 10, 5 * 60, "Too many code attempts. Wait a few minutes.");
    if (!verifyTotp(decryptSecret(user.totpSecretEnc), input.totp)) {
      await logEvent(ctx, input.email, false, input.portal, user.id, "bad_totp");
      throw new AppError("UNAUTHENTICATED", "Incorrect authentication code");
    }
  }

  await db.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } });
  const { token } = await createSession(user.id, ctx);
  await logEvent(ctx, input.email, true, input.portal, user.id);
  await audit({ ...ctx, actor: { userId: user.id, email: user.email, name: user.name, role: user.role, clientId: user.clientId, permissions: [], isOwner: false, businessIds: [], sessionId: null } }, {
    action: "auth.login",
    entityType: "User",
    entityId: user.id,
    clientId: user.clientId,
  });
  return { token, role: user.role, redirectTo: user.role === "SUPER_ADMIN" ? "/admin" : "/client" };
}

export async function logout(ctx: Ctx) {
  const a = ctx.actor;
  if (!a?.sessionId) return;
  await db.session.updateMany({ where: { id: a.sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
  await audit(ctx, { action: "auth.logout", entityType: "User", entityId: a.userId });
}

// ───────────── TOTP ─────────────

function totpFor(secretBase32: string, label: string) {
  return new OTPAuth.TOTP({ issuer: "YouPI PG", label, algorithm: "SHA1", digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secretBase32) });
}

export function verifyTotp(secretBase32: string, code: string): boolean {
  return totpFor(secretBase32, "x").validate({ token: code, window: 1 }) !== null;
}

export async function beginTotpSetup(ctx: Ctx) {
  const a = requireActor(ctx);
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  await db.user.update({ where: { id: a.userId }, data: { totpSecretEnc: encryptSecret(secret), totpEnabled: false } });
  const uri = totpFor(secret, a.email).toString();
  return { secret, otpauthUri: uri };
}

export async function confirmTotpSetup(ctx: Ctx, raw: unknown) {
  const a = requireActor(ctx);
  const { code } = parse(z.object({ code: z.string().regex(/^[0-9]{6}$/, "Enter the 6-digit code") }), raw);
  const u = await db.user.findUniqueOrThrow({ where: { id: a.userId } });
  if (!u.totpSecretEnc) throw badRequest("Start two-factor setup first");
  await enforceRateLimit(`totp:${u.id}`, 10, 5 * 60, "Too many code attempts. Wait a few minutes.");
  if (!verifyTotp(decryptSecret(u.totpSecretEnc), code)) throw new AppError("VALIDATION", "That code is not correct");
  await db.user.update({ where: { id: u.id }, data: { totpEnabled: true } });
  await audit(ctx, { action: "auth.2fa_enabled", entityType: "User", entityId: u.id });
}

export async function disableTotp(ctx: Ctx, raw: unknown) {
  const a = requireActor(ctx);
  const { password } = parse(z.object({ password: z.string().min(1) }), raw);
  const u = await db.user.findUniqueOrThrow({ where: { id: a.userId } });
  if (!u.passwordHash || !(await verifyPassword(u.passwordHash, password))) throw new AppError("VALIDATION", "Password is incorrect");
  await db.user.update({ where: { id: u.id }, data: { totpEnabled: false, totpSecretEnc: null } });
  await audit(ctx, { action: "auth.2fa_disabled", entityType: "User", entityId: u.id });
}

// ───────────── password reset / invite ─────────────

const TOKEN_TTL: Record<"PASSWORD_RESET" | "INVITE", number> = { PASSWORD_RESET: 60 * 60 * 1000, INVITE: 7 * 24 * 3600 * 1000 };

export async function issueToken(userId: string, purpose: "PASSWORD_RESET" | "INVITE") {
  await db.authToken.updateMany({ where: { userId, purpose, usedAt: null }, data: { usedAt: new Date() } });
  const raw = randomToken(32);
  await db.authToken.create({
    data: { userId, purpose, tokenHash: sha256Hex(raw), expiresAt: new Date(Date.now() + TOKEN_TTL[purpose]) },
  });
  const path = purpose === "INVITE" ? "set-password" : "reset-password";
  return { raw, link: `${env().APP_URL}/auth/${path}?token=${raw}` };
}

/** Always answers the same way so it cannot be used to discover which emails exist. */
export async function requestPasswordReset(ctx: Ctx, raw: unknown) {
  const { email } = parse(z.object({ email: emailSchema }), raw);
  await enforceRateLimit(`reset:ip:${ctx.ip ?? "unknown"}`, 10, 3600);
  await enforceRateLimit(`reset:email:${email}`, 3, 3600);
  const user = await db.user.findUnique({ where: { email } });
  if (user && user.status !== "SUSPENDED") {
    const { link } = await issueToken(user.id, "PASSWORD_RESET");
    await notify({
      userId: user.id,
      to: user.email,
      type: "auth.password_reset",
      subject: "Reset your YouPI PG password",
      body: "We received a request to reset your password. This link works for 1 hour. If this was not you, ignore this email.",
      link,
    });
    await audit({ ...ctx, actor: null }, { action: "auth.reset_requested", entityType: "User", entityId: user.id, clientId: user.clientId });
  }
  return { ok: true };
}

export async function checkToken(rawToken: string, purpose?: "PASSWORD_RESET" | "INVITE") {
  const t = await db.authToken.findUnique({ where: { tokenHash: sha256Hex(rawToken) }, include: { user: true } });
  if (!t || t.usedAt || t.expiresAt < new Date() || (purpose && t.purpose !== purpose)) return null;
  return t;
}

export async function setPasswordWithToken(ctx: Ctx, raw: unknown) {
  const input = parse(z.object({ token: z.string().min(10).max(200), password: passwordSchema }), raw);
  await enforceRateLimit(`settoken:ip:${ctx.ip ?? "unknown"}`, 20, 3600);
  const t = await checkToken(input.token);
  if (!t) throw new AppError("BAD_REQUEST", "This link is invalid or has expired. Request a new one.");
  const hash = await hashPassword(input.password);
  await db.$transaction(async (tx) => {
    const claimed = await tx.authToken.updateMany({ where: { id: t.id, usedAt: null }, data: { usedAt: new Date() } });
    if (claimed.count !== 1) throw new AppError("BAD_REQUEST", "This link has already been used.");
    await tx.user.update({
      where: { id: t.userId },
      data: {
        passwordHash: hash,
        passwordChangedAt: new Date(),
        failedLoginCount: 0,
        lockedUntil: null,
        status: t.user.status === "INVITED" ? "ACTIVE" : t.user.status,
      },
    });
    await audit({ ...ctx, actor: null }, { action: t.purpose === "INVITE" ? "auth.invite_accepted" : "auth.password_reset", entityType: "User", entityId: t.userId, clientId: t.user.clientId }, tx);
  });
  await revokeAllSessions(t.userId);
  return { role: t.user.role };
}

export async function changePassword(ctx: Ctx, raw: unknown) {
  const a = requireActor(ctx);
  const input = parse(z.object({ currentPassword: z.string().min(1), newPassword: passwordSchema }), raw);
  const u = await db.user.findUniqueOrThrow({ where: { id: a.userId } });
  if (!u.passwordHash || !(await verifyPassword(u.passwordHash, input.currentPassword))) {
    throw new AppError("VALIDATION", "Current password is incorrect");
  }
  await db.user.update({ where: { id: u.id }, data: { passwordHash: await hashPassword(input.newPassword), passwordChangedAt: new Date() } });
  await revokeAllSessions(u.id, a.sessionId);
  await audit(ctx, { action: "auth.password_changed", entityType: "User", entityId: u.id });
}

export async function recentLogins(ctx: Ctx, limit = 10) {
  const a = requireActor(ctx);
  return db.loginEvent.findMany({ where: { userId: a.userId }, orderBy: { createdAt: "desc" }, take: limit });
}
