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

  /** Brevo (transactional SMS). Optional in development, required in production. */
  BREVO_API_KEY: z.string().optional(),
  /** Sender name: up to 11 letters/digits, or a 12-15 digit number. Must be approved in Brevo. */
  BREVO_SMS_SENDER: z.string().optional(),
  /** Country code added to 10-digit numbers. */
  DEFAULT_COUNTRY_CODE: z
    .string()
    .regex(/^\+[1-9][0-9]{0,3}$/, "Use a value like +91")
    .default("+91"),

  // Admin bootstrap (npm run admin:create)
  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_PASSWORD: z.string().optional(),
  SEED_ADMIN_NAME: z.string().optional(),
  SEED_ADMIN_USERNAME: z.string().optional(),
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
    const missing = (["BREVO_API_KEY", "BREVO_SMS_SENDER", "APP_SECRET"] as const).filter((k) => !e[k]);
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
