import { z } from "zod";

/**
 * Central, validated environment access. Parsed lazily so that `next build`
 * and tests that do not need every variable do not fail at import time.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  /** Random string (16+ chars) used as a pepper when hashing one-time codes. */
  APP_SECRET: z.string().min(16).optional(),
  TRUST_PROXY: z.enum(["true", "false"]).optional(),

  /** Brevo (transactional email). Optional in development, required in production. */
  BREVO_API_KEY: z.string().optional(),
  /** Sender address for OTP emails. Must be a verified sender (or domain) in Brevo. */
  BREVO_SENDER_EMAIL: z.string().email().optional(),
  /** Sender display name. */
  BREVO_SENDER_NAME: z.string().min(1).default("YouPI PG"),
  /** Country code added to 10-digit numbers. */
  DEFAULT_COUNTRY_CODE: z
    .string()
    .regex(/^\+[1-9][0-9]{0,3}$/, "Use a value like +91")
    .default("+91"),

  /** Easebuzz payment gateway. Without key and salt, online payments are switched off. */
  EASEBUZZ_KEY: z.string().optional(),
  EASEBUZZ_SALT: z.string().optional(),
  /** "test" uses the Easebuzz sandbox, "prod" the live gateway. */
  EASEBUZZ_ENV: z.enum(["test", "prod"]).default("test"),
  /** Shared secret the refund webhook must send (header x-webhook-token or ?token=). */
  EASEBUZZ_WEBHOOK_TOKEN: z.string().optional(),
  /** Hash layout used to check refund webhook payloads: "refund" (key|merchant_refund_id|easebuzz_id|refund_amount|salt) or "off". */
  EASEBUZZ_WEBHOOK_HASH: z.enum(["refund", "off"]).default("refund"),

  // Admin bootstrap (npm run admin:create)
  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_PASSWORD: z.string().optional(),
  SEED_ADMIN_NAME: z.string().optional(),
  SEED_ADMIN_USERNAME: z.string().optional(),

  // Admin 2 (auditor) bootstrap (npm run auditor:create)
  SEED_AUDITOR_EMAIL: z.string().email().optional(),
  SEED_AUDITOR_PASSWORD: z.string().optional(),
  SEED_AUDITOR_NAME: z.string().optional(),
  SEED_AUDITOR_USERNAME: z.string().optional(),
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
  const e = parsed.data;
  if (e.NODE_ENV === "production") {
    const missing = (["BREVO_API_KEY", "BREVO_SENDER_EMAIL", "APP_SECRET"] as const).filter((k) => !e[k]);
    if (missing.length) throw new Error(`Missing required environment variables in production: ${missing.join(", ")}`);
  }
  cached = e;
  return cached;
}

/** For tests: forget the cached parse after changing process.env. */
export function resetEnvCache() {
  cached = null;
}

export const isProd = () => process.env.NODE_ENV === "production";
