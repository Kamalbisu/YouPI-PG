import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./env";

export const sha256Hex = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Keyed hash (HMAC-SHA256 with APP_SECRET) used for one-time codes. */
export function keyedHash(value: string): string {
  const secret = env().APP_SECRET ?? "dev-only-secret-change-me";
  return createHmac("sha256", secret).update(value).digest("hex");
}
