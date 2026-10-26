import { z } from "zod";

/**
 * Central, validated environment access. Parsed lazily so that `next build`
 * and tests that do not need every variable do not fail at import time.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  /** 32 random bytes, base64. Encrypts provider credentials and 2FA secrets. */
  APP_ENCRYPTION_KEY: z.string().min(1).optional(),
  /** Random string used as a pepper when hashing IP addresses for QR scan stats. */
  APP_SECRET: z.string().min(16).optional(),
  TRUST_PROXY: z.enum(["true", "false"]).optional(),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_SECURE: z.enum(["true", "false"]).optional(),
  MAIL_FROM: z.string().default("YouPI PG <no-reply@localhost>"),

  // Platform-level default provider accounts (optional; per-business configs override)
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  CASHFREE_APP_ID: z.string().optional(),
  CASHFREE_SECRET_KEY: z.string().optional(),
  CASHFREE_ENV: z.enum(["sandbox", "production"]).optional(),

  /** Local development simulator. Refused when NODE_ENV=production. */
  PAYMENT_SIMULATOR_ENABLED: z.enum(["true", "false"]).optional(),

  // Seed / bootstrap
  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_PASSWORD: z.string().optional(),
  SEED_ADMIN_NAME: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${msg}`);
  }
  cached = parsed.data;
  if (cached.NODE_ENV === "production") {
    if (cached.PAYMENT_SIMULATOR_ENABLED === "true") {
      throw new Error("PAYMENT_SIMULATOR_ENABLED must not be true in production");
    }
  }
  return cached;
}

/** For tests: forget the cached parse after changing process.env. */
export function resetEnvCache() {
  cached = null;
}

export const isProd = () => process.env.NODE_ENV === "production";

export function simulatorEnabled(): boolean {
  const e = env();
  return e.NODE_ENV !== "production" && e.PAYMENT_SIMULATOR_ENABLED === "true";
}
