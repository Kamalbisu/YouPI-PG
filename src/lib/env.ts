import { z } from "zod";

/**
 * Central, validated environment access. Parsed lazily so that `next build`
 * and tests that do not need every variable do not fail at import time.
 */
/** Treat an empty value (e.g. `MSG91_SENDER_EMAIL=` in .env) as not set. */
const blank = <T extends z.ZodTypeAny>(s: T) => z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), s.optional());

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  /** Random string (16+ chars) used as a pepper when hashing one-time codes. */
  APP_SECRET: z.string().min(16).optional(),
  TRUST_PROXY: z.enum(["true", "false"]).optional(),

  /** MSG91 (transactional email). Optional in development, required in production. */
  MSG91_AUTH_KEY: blank(z.string().trim()),
  /** Sender address for OTP emails. Its domain must be added and verified in MSG91 (Email > Domains). */
  MSG91_SENDER_EMAIL: blank(z.string().trim().email()),
  /** Sender display name, also passed to the template as company_name. */
  MSG91_SENDER_NAME: z.string().trim().min(1).default("YouPI PG"),
  /** Verified MSG91 sending domain. Defaults to the domain of MSG91_SENDER_EMAIL. */
  MSG91_EMAIL_DOMAIN: blank(z.string().trim()),
  /** Id of the MSG91 email template for login codes. It must use the variable otp. */
  MSG91_OTP_TEMPLATE_ID: blank(z.string().trim()),
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
    const missing = (["MSG91_AUTH_KEY", "MSG91_SENDER_EMAIL", "MSG91_OTP_TEMPLATE_ID", "APP_SECRET"] as const).filter((k) => !e[k]);
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
