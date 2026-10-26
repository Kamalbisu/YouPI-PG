import { randomBytes, randomInt } from "node:crypto";

// Crockford-style base32 without ambiguous characters (no I, L, O, U, 0, 1).
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Human-friendly random code, e.g. randomCode("CL", 8) -> "CL-4F7K2Q9D". */
export function randomCode(prefix: string, length = 8): string {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return `${prefix}-${out}`;
}

/** URL-safe unguessable token. 24 bytes = 192 bits by default. */
export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

export function dateStamp(d = new Date()): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

/** Run `fn` with a fresh code until it does not collide on a unique index. */
export async function withUniqueCode<T>(make: () => string, fn: (code: string) => Promise<T>, tries = 6): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn(make());
    } catch (e) {
      lastErr = e;
      if ((e as { code?: string })?.code === "P2002") continue;
      throw e;
    }
  }
  throw lastErr;
}
