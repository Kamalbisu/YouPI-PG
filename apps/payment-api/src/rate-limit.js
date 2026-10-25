import net from 'node:net';

/**
 * Resolves the client address for rate limiting.
 *
 * By default only the socket address is used. Behind a reverse proxy or the Cloudflare
 * tunnel every request arrives from the proxy, so set YOUPI_TRUST_PROXY_HEADERS=true to read
 * CF-Connecting-IP (then the first X-Forwarded-For hop). Only enable it when the API port is
 * reachable solely through that proxy: otherwise a client could spoof the header.
 */
export function getClientIp(req) {
  const socketIp = req.socket?.remoteAddress || '127.0.0.1';
  if (process.env.YOUPI_TRUST_PROXY_HEADERS !== 'true') return socketIp;

  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  if (cf && net.isIP(cf)) return cf;

  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (xff && net.isIP(xff)) return xff;

  return socketIp;
}

/**
 * Fixed-memory sliding-window limiter. The key table is capped, so a flood of distinct keys
 * cannot grow it without bound: expired entries are swept first, then the oldest are dropped.
 * @param {{ windowMs: number, max: number, maxKeys?: number }} opts
 */
export function createRateLimiter({ windowMs, max, maxKeys = 10000 }) {
  /** @type {Map<string, number[]>} */
  const hits = new Map();

  function sweep(now) {
    for (const [key, stamps] of hits) {
      if (!stamps.length || now - stamps[stamps.length - 1] >= windowMs) hits.delete(key);
    }
    while (hits.size >= maxKeys) hits.delete(hits.keys().next().value);
  }

  return {
    /** Records one attempt. Returns true when it is allowed, false when over the limit. */
    allow(key) {
      const now = Date.now();
      if (!hits.has(key) && hits.size >= maxKeys) sweep(now);
      const recent = (hits.get(key) || []).filter(t => now - t < windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      return true;
    },
    /** True when the key is already at its limit. Does not record an attempt. */
    isLimited(key) {
      const now = Date.now();
      return (hits.get(key) || []).filter(t => now - t < windowMs).length >= max;
    },
    /** Forgets one key (for example after a successful login). */
    clear(key) { hits.delete(key); },
    reset() { hits.clear(); }
  };
}

/**
 * Reads a non-negative integer limit from the environment. 0 disables the limit.
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
export function envLimit(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}
