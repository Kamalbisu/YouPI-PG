import { randomInt } from "node:crypto";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { keyedHash, safeEqual } from "@/lib/crypto";
import { enforceRateLimit } from "@/lib/rate-limit";
import type { Ctx } from "@/server/auth/types";
import { sendEmail } from "./mailer";
import { maskEmail, recordActivity } from "./activity";

export type OtpPurpose = "LOGIN" | "SIGNUP";

export const OTP_TTL_MS = 5 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_SEC = 45;
const PER_EMAIL_PER_HOUR = 6;
const PER_IP_PER_HOUR = 20;

const hashCode = (email: string, purpose: OtpPurpose, code: string) => keyedHash(`otp:${purpose}:${email}:${code}`);
const invalid = () => new AppError("VALIDATION", "That code is wrong or has expired. Request a new one.", { fields: { code: "Wrong or expired code" } });

/** Create and email a fresh code. Older unused codes for the same address and purpose stop working. */
export async function requestOtp(
  ctx: Ctx,
  input: { email: string; purpose: OtpPurpose; payload?: Record<string, unknown> },
): Promise<{ expiresInSec: number; resendInSec: number }> {
  const { email, purpose } = input;
  const ip = ctx.ip ?? "unknown";

  await enforceRateLimit(`otp:ip:${ip}`, PER_IP_PER_HOUR, 3600, "Too many code requests. Please try again later.");

  const last = await db.otpCode.findFirst({ where: { email }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  if (last) {
    const wait = Math.ceil((last.createdAt.getTime() + OTP_RESEND_COOLDOWN_SEC * 1000 - Date.now()) / 1000);
    if (wait > 0) {
      throw new AppError("RATE_LIMITED", `Please wait ${wait} seconds before asking for another code.`, { retryAfterSec: wait });
    }
  }
  await enforceRateLimit(`otp:email:${email}`, PER_EMAIL_PER_HOUR, 3600, "Too many codes sent to this email. Try again in an hour.");

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const now = new Date();
  await db.$transaction([
    db.otpCode.updateMany({ where: { email, purpose, consumedAt: null }, data: { consumedAt: now } }),
    db.otpCode.create({
      data: {
        email,
        purpose,
        codeHash: hashCode(email, purpose, code),
        payload: input.payload as object | undefined,
        expiresAt: new Date(now.getTime() + OTP_TTL_MS),
        ip: ctx.ip,
      },
    }),
  ]);

  try {
    await sendEmail(
      email,
      {
        subject: `${code} is your YouPI PG verification code`,
        text: `Your YouPI PG verification code is ${code}.\n\nIt is valid for 5 minutes. Do not share it with anyone. If you did not ask for this code, you can ignore this email.`,
        variables: { otp: code },
      },
      { devLabel: `OTP ${purpose}` },
    );
  } catch (e) {
    // The code was never delivered: forget it so the member can retry straight away.
    await db.otpCode.deleteMany({ where: { email, purpose, consumedAt: null, createdAt: { gte: now } } });
    throw e;
  }
  await recordActivity(ctx, { type: "auth.otp.sent", actor: { type: "SYSTEM" }, metadata: { purpose, email: maskEmail(email) } });
  return { expiresInSec: OTP_TTL_MS / 1000, resendInSec: OTP_RESEND_COOLDOWN_SEC };
}

/**
 * Check a code. A code works once, expires after 5 minutes and is burned after 5 wrong tries.
 * Returns the payload stored when the code was requested (signup details).
 */
export async function verifyOtp(
  ctx: Ctx,
  input: { email: string; purpose: OtpPurpose; code: string },
): Promise<{ payload: Record<string, unknown> | null }> {
  const { email, purpose, code } = input;
  await enforceRateLimit(`otpverify:ip:${ctx.ip ?? "unknown"}`, 40, 900, "Too many attempts. Please try again later.");

  const row = await db.otpCode.findFirst({
    where: { email, purpose, consumedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!row) {
    await recordActivity(ctx, { type: "auth.otp.failed", actor: { type: "SYSTEM" }, metadata: { purpose, email: maskEmail(email), reason: "no active code" } });
    throw invalid();
  }

  // Count the attempt first (atomically) so parallel guesses cannot exceed the limit.
  const counted = await db.otpCode.updateMany({
    where: { id: row.id, consumedAt: null, attempts: { lt: OTP_MAX_ATTEMPTS } },
    data: { attempts: { increment: 1 } },
  });
  if (counted.count === 0) {
    await recordActivity(ctx, { type: "auth.otp.failed", actor: { type: "SYSTEM" }, metadata: { purpose, email: maskEmail(email), reason: "too many attempts" } });
    throw invalid();
  }

  const ok = safeEqual(row.codeHash, hashCode(email, purpose, code));
  if (!ok) {
    if (row.attempts + 1 >= OTP_MAX_ATTEMPTS) {
      await db.otpCode.updateMany({ where: { id: row.id }, data: { consumedAt: new Date() } });
    }
    await recordActivity(ctx, { type: "auth.otp.failed", actor: { type: "SYSTEM" }, metadata: { purpose, email: maskEmail(email), reason: "wrong code" } });
    throw invalid();
  }
  // Single use: only one caller can flip consumedAt.
  const used = await db.otpCode.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: new Date() } });
  if (used.count !== 1) throw invalid();
  await recordActivity(ctx, { type: "auth.otp.verified", actor: { type: "SYSTEM" }, metadata: { purpose, email: maskEmail(email) } });
  return { payload: (row.payload as Record<string, unknown> | null) ?? null };
}
