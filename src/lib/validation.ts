import { z } from "zod";
import { AppError } from "./errors";

export const emailSchema = z.string().trim().toLowerCase().email("Enter a valid email").max(254);
export const nameSchema = z.string().trim().min(2, "Name is too short").max(80, "Name is too long");
export const idSchema = z.string().min(1).max(64);

export const passwordSchema = z
  .string()
  .min(10, "Use at least 10 characters")
  .max(200)
  .refine((p) => /[a-z]/.test(p) && /[A-Z]/.test(p) && /[0-9]/.test(p), "Use upper case, lower case and a number");

/** 3-30 characters: a-z, 0-9 and underscore. Stored lower case, so usernames are case-insensitive. */
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]{3,30}$/, "Username must be 3-30 characters: letters, numbers or underscore");

/** Same rules as the username, used for sign-in where we only need a non-empty value. */
export const loginIdSchema = z.string().trim().toLowerCase().min(1, "Enter your username").max(254);

/**
 * Indian mobile number: 10 digits starting 6-9, optionally written with +91 / 91 / 0.
 * Returns E.164 using the given default country code (default +91).
 */
export function normalizeMobile(input: string, countryCode = "+91"): string | null {
  const digits = input.replace(/[\s()-]/g, "");
  const cc = countryCode.replace(/\D/g, "");
  let national: string;
  if (digits.startsWith("+")) {
    if (!digits.startsWith(`+${cc}`)) return null;
    national = digits.slice(cc.length + 1);
  } else if (digits.startsWith(cc) && digits.length === cc.length + 10) {
    national = digits.slice(cc.length);
  } else if (digits.startsWith("0") && digits.length === 11) {
    national = digits.slice(1);
  } else {
    national = digits;
  }
  if (!/^[6-9][0-9]{9}$/.test(national)) return null;
  return `+${cc}${national}`;
}

export const mobileSchema = z
  .string()
  .trim()
  .max(20)
  .transform((v, ctx) => {
    const cc = process.env.DEFAULT_COUNTRY_CODE || "+91";
    const n = normalizeMobile(v, cc);
    if (!n) {
      ctx.addIssue({ code: "custom", message: "Enter a valid 10 digit mobile number" });
      return z.NEVER;
    }
    return n;
  });

export const otpCodeSchema = z.string().trim().regex(/^[0-9]{6}$/, "Enter the 6 digit code");

/** Transaction / UTR / reference id: 8-30 letters or digits, stored upper case. */
export const txnIdSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{8,30}$/, "Enter the transaction ID (8-30 letters or numbers, no spaces)");

/** Parse with zod and convert failures to an AppError the API layer understands. */
export function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const fields: Record<string, string> = {};
    for (const i of r.error.issues) {
      const k = i.path.join(".") || "_";
      if (!fields[k]) fields[k] = i.message;
    }
    throw new AppError("VALIDATION", Object.values(fields)[0] ?? "Invalid input", { fields });
  }
  return r.data;
}
