/** Remove secrets from objects before they are logged, audited or stored. */

export const SENSITIVE_KEY = /pass|secret|token|otp|totp|key|signature|authorization|cookie|salt|hash|cvv|card_?(num|no)|cardnum|^pan$/i;

export function redact(v: unknown, pattern: RegExp = SENSITIVE_KEY, depth = 0): unknown {
  if (v === null || v === undefined) return v;
  if (depth > 4) return "[truncated]";
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redact(x, pattern, depth + 1));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = pattern.test(k) ? "[redacted]" : redact(val, pattern, depth + 1);
    }
    return out;
  }
  if (typeof v === "string" && v.length > 500) return v.slice(0, 500) + "…";
  return v;
}
