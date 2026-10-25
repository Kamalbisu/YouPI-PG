import net from 'node:net';

export function getClientIp(req) {
  const socketIp = req.socket?.remoteAddress || '127.0.0.1';
  if (process.env.YOUPI_TRUST_PROXY_HEADERS !== 'true') return socketIp;

  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  if (cf && net.isIP(cf)) return cf;

  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (xff && net.isIP(xff)) return xff;

  return socketIp;
}

export function createRateLimiter({ windowMs, max, maxKeys = 10000 }) {
  const hits = new Map();

  function sweep(now) {
    for (const [key, stamps] of hits) {
      if (!stamps.length || now - stamps[stamps.length - 1] >= windowMs) hits.delete(key);
    }
    while (hits.size >= maxKeys) hits.delete(hits.keys().next().value);
  }

  return {
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
    isLimited(key) {
      const now = Date.now();
      return (hits.get(key) || []).filter(t => now - t < windowMs).length >= max;
    },
    clear(key) { hits.delete(key); },
    reset() { hits.clear(); }
  };
}

export function envLimit(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}
