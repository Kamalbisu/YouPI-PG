import { getAdminToken, getObserverToken, safeEqual, hasBearer } from '@youpi/common';
import { HttpServer } from './server.js';

const PUBLIC_ADMIN_PATHS = new Set(['/api/v1/admin/sms-gateway/download-apk']);

const OBSERVER_ADMIN_PATHS = new Set(['/api/v1/admin/gmail/credentials']);

function bearerToken(req) {
  const header = req.headers['authorization'] || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : '';
}

function isDevTool(pathname) {
  return pathname.startsWith('/api/v1/admin/dev/') || /^\/api\/v1\/checkout\/[^/]+\/simulate-observation$/.test(pathname);
}

function requiredLevel(method, pathname) {
  if (pathname.startsWith('/api/v1/admin/')) {
    if (PUBLIC_ADMIN_PATHS.has(pathname)) return null;
    if (OBSERVER_ADMIN_PATHS.has(pathname)) return 'observer';
    return 'admin';
  }
  if (method === 'POST' && pathname === '/api/v1/pollers/events') return 'observer';
  if (method === 'POST' && /^\/api\/v1\/checkout\/[^/]+\/simulate-observation$/.test(pathname)) return 'admin';
  return null;
}

export function authGuard(req, res, pathname, url) {
  const method = req.method.toUpperCase();

  if (method !== 'GET' && isDevTool(pathname) && (process.env.NODE_ENV === 'production' || process.env.YOUPI_MODE === 'production') && process.env.YOUPI_ALLOW_DEV_TOOLS !== 'true') {
    HttpServer.json(res, 403, { error: 'Developer tools are disabled in production.', code: 'DEV_TOOLS_DISABLED' });
    return true;
  }

  const level = requiredLevel(method, pathname);
  if (!level) return false;

  const presented = bearerToken(req);

  const ok = presented && (
    safeEqual(presented, getAdminToken()) ||
    (level === 'observer' && safeEqual(presented, getObserverToken()))
  );
  if (ok) return false;

  HttpServer.json(res, 401, { error: 'Unauthorized', code: 'AUTH_REQUIRED' });
  return true;
}

export function isAdminRequest(req) {
  const presented = bearerToken(req);
  return Boolean(presented) && safeEqual(presented, getAdminToken());
}

export function isObserverRequest(req) {
  const presented = bearerToken(req);
  return Boolean(presented) && safeEqual(presented, getObserverToken()) && !safeEqual(presented, getAdminToken());
}

export async function isPaymentOwner(req, session, ctx) {
  if (isAdminRequest(req)) return true;
  if (hasBearer(req, getObserverToken())) return true;

  const presented = req.headers['x-merchant-key'];
  if (!presented || typeof presented !== 'string' || !presented.trim()) return false;

  const merchant = ctx.merchantRepo?.findById ? await ctx.merchantRepo.findById(session.merchantId) : null;
  if (!merchant) return false;
  if (typeof ctx.merchantRepo?.verifyApiKey === 'function') {
    return await ctx.merchantRepo.verifyApiKey(merchant, presented.trim());
  }
  if (!merchant.webhookSecret) return false;
  return safeEqual(presented.trim(), merchant.webhookSecret);
}
