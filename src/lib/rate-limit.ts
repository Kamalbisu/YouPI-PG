import { db } from "./db";
import { AppError } from "./errors";

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  retryAfterSec: number;
}

/**
 * Fixed-window rate limiter stored in PostgreSQL so limits hold across instances and restarts.
 * `key` should include the scope, e.g. `login:ip:1.2.3.4`.
 */
export async function rateLimit(key: string, limit: number, windowSec: number): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStartMs = Math.floor(now / (windowSec * 1000)) * windowSec * 1000;
  const windowStart = new Date(windowStartMs);
  const rows = await db.$queryRaw<{ count: number }[]>`
    INSERT INTO rate_limit_buckets ("key", "windowStart", "count")
    VALUES (${key}, ${windowStart}, 1)
    ON CONFLICT ("key", "windowStart") DO UPDATE SET "count" = rate_limit_buckets."count" + 1
    RETURNING "count"`;
  const count = Number(rows[0]?.count ?? 1);
  const retryAfterSec = Math.max(1, Math.ceil((windowStartMs + windowSec * 1000 - now) / 1000));
  return { allowed: count <= limit, count, limit, retryAfterSec };
}

/** Throws RATE_LIMITED when over the limit. */
export async function enforceRateLimit(key: string, limit: number, windowSec: number, message?: string) {
  const r = await rateLimit(key, limit, windowSec);
  if (!r.allowed) {
    throw new AppError("RATE_LIMITED", message ?? "Too many requests. Please try again shortly.", {
      retryAfterSec: r.retryAfterSec,
    });
  }
}

/** Housekeeping: drop buckets older than a day. Safe to call from a cron / opportunistically. */
export async function purgeRateLimitBuckets() {
  await db.rateLimitBucket.deleteMany({ where: { windowStart: { lt: new Date(Date.now() - 24 * 3600 * 1000) } } });
}
