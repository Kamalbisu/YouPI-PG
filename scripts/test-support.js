export const TEST_ADMIN_TOKEN = 'test-admin-token-0123456789abcdef0123456789abcdef';
export const TEST_OBSERVER_TOKEN = 'test-observer-token-0123456789abcdef0123456789abcd';

process.env.ADMIN_API_TOKEN = TEST_ADMIN_TOKEN;
process.env.OBSERVER_API_TOKEN = TEST_OBSERVER_TOKEN;
process.env.YOUPI_EXPOSE_DEV_OTP = 'true';
process.env.YOUPI_ALLOW_PRIVATE_WEBHOOKS = 'true';

export function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${TEST_ADMIN_TOKEN}`, ...extra };
}

export function authFetch(url, init = {}) {
  return fetch(url, { ...init, headers: { ...authHeadersFor(url), ...(init.headers || {}) } });
}

const GUARDED = /\/api\/v1\/admin\/|\/api\/v1\/pollers\/events|\/api\/v1\/pollers\/active-window|\/simulate-observation|\/api\/v1\/payments(\?|$)/;

export function authHeadersFor(path, extra = {}) {
  return GUARDED.test(String(path)) ? authHeaders(extra) : { ...extra };
}

export function merchantHeaders(webhookSecret, extra = {}) {
  return { 'X-Merchant-Key': webhookSecret, ...extra };
}
