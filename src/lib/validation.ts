import { z } from "zod";
import { AppError } from "./errors";

export const emailSchema = z.string().trim().toLowerCase().email("Enter a valid email").max(254);
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9][0-9 ()-]{6,18}$/, "Enter a valid phone number");
export const optionalPhone = z.union([phoneSchema, z.literal("").transform(() => undefined)]).optional();
export const optionalText = (max = 500) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s === "" ? undefined : s))
    .optional();
export const nameSchema = z.string().trim().min(2, "Too short").max(120);
export const idSchema = z.string().min(1).max(64);
export const pincodeSchema = z.string().trim().regex(/^[0-9]{6}$/, "Enter a 6 digit PIN code");
export const upiVpaSchema = z.string().trim().regex(/^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/, "Enter a valid UPI ID");
export const taxBpsSchema = z.number().int().min(0).max(10000);
export const amountMinorSchema = z.number().int().min(1).max(10_000_000_00);

export const passwordSchema = z
  .string()
  .min(10, "Use at least 10 characters")
  .max(200)
  .refine((p) => /[a-z]/.test(p) && /[A-Z]/.test(p) && /[0-9]/.test(p), "Use upper case, lower case and a number");

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
