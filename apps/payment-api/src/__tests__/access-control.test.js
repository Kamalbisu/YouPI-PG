import { TEST_ADMIN_TOKEN, TEST_OBSERVER_TOKEN } from '../../../../scripts/test-support.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Database, CustomerRepository, CustomerSessionRepository, DeviceRepository, runMigrations } from '@youpi/db';
import { startServer as startPaymentApi } from '../index.js';

const MERCHANT_ID = '00000000-0000-0000-0000-000000000001';

describe('access control hardening', () => {
  let api;
  let db;
  let customerRepo;
  let sessionRepo;
  let deviceRepo;

  before(async () => {
    db = new Database({ inMemory: true });
    api = await startPaymentApi(6297, db);
    customerRepo = new CustomerRepository(db);
    sessionRepo = new CustomerSessionRepository(db, customerRepo);
    deviceRepo = new DeviceRepository(db);
  });

  after(async () => {
    await api.close();
    db.close();
  });

  async function call(path, { method = 'GET', body, headers = {} } = {}) {
    const res = await fetch(`http://localhost:${api.port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed };
  }

  const admin = { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` };
  const observer = { Authorization: `Bearer ${TEST_OBSERVER_TOKEN}` };

  test('M5: Gmail credentials are masked for the admin token and revealed only to the observer token', async () => {
    const save = await call('/api/v1/admin/gmail/credentials', {
      method: 'POST',
      headers: admin,
      body: { merchantId: MERCHANT_ID, clientId: 'cid.apps.googleusercontent.com', clientSecret: 'GOCSPX-real-secret', refreshToken: '1//real-refresh', apiKey: 'real-api-key' }
    });
    assert.equal(save.status, 200);

    const asAdmin = await call(`/api/v1/admin/gmail/credentials?merchantId=${MERCHANT_ID}`, { headers: admin });
    assert.equal(asAdmin.status, 200);
    const adminText = JSON.stringify(asAdmin.body);
    for (const secret of ['GOCSPX-real-secret', '1//real-refresh', 'real-api-key']) {
      assert.ok(!adminText.includes(secret), `admin response leaked ${secret}`);
    }
    assert.equal(asAdmin.body.hasClientSecret, true);
    assert.equal(asAdmin.body.hasRefreshToken, true);
    assert.equal(asAdmin.body.oauthStatus, 'CONNECTED');
    assert.equal(asAdmin.body.clientId, 'cid.apps.googleusercontent.com');

    const asObserver = await call(`/api/v1/admin/gmail/credentials?merchantId=${MERCHANT_ID}`, { headers: observer });
    assert.equal(asObserver.status, 200);
    assert.equal(asObserver.body.gmailConfig.clientSecret, 'GOCSPX-real-secret');
    assert.equal(asObserver.body.gmailConfig.refreshToken, '1//real-refresh');

    const anon = await call('/api/v1/admin/gmail/credentials');
    assert.equal(anon.status, 401);
  });

  test('M5: saving the masked placeholder back does not overwrite stored secrets', async () => {
    const masked = (await call(`/api/v1/admin/gmail/credentials?merchantId=${MERCHANT_ID}`, { headers: admin })).body;
    const save = await call('/api/v1/admin/gmail/credentials', {
      method: 'POST',
      headers: admin,
      body: { merchantId: MERCHANT_ID, clientId: masked.clientId, clientSecret: masked.clientSecret, refreshToken: masked.refreshToken, apiKey: masked.apiKey }
    });
    assert.equal(save.status, 200);
    const after = await call(`/api/v1/admin/gmail/credentials?merchantId=${MERCHANT_ID}`, { headers: observer });
    assert.equal(after.body.gmailConfig.clientSecret, 'GOCSPX-real-secret');
    assert.equal(after.body.gmailConfig.refreshToken, '1//real-refresh');
    assert.equal(after.body.gmailConfig.apiKey, 'real-api-key');
  });

  test('M6: device lookups require the owner, the device itself or the admin', async () => {
    const owner = customerRepo.create({ merchantId: MERCHANT_ID, name: 'Owner', email: 'owner@example.com', mobileNumber: '9000000001' });
    const other = customerRepo.create({ merchantId: MERCHANT_ID, name: 'Other', email: 'other@example.com', mobileNumber: '9000000002' });
    const ownerToken = sessionRepo.create({ customerId: owner.id }).token;
    const otherToken = sessionRepo.create({ customerId: other.id }).token;
    const device = deviceRepo.create({ customerId: owner.id, publicKey: 'pk-access-control-1', fingerprintHash: 'fp1', platform: 'web' });

    assert.equal((await call(`/api/v1/devices/${device.id}`)).status, 404);
    assert.equal((await call(`/api/v1/devices/${device.id}`, { headers: { 'X-Customer-Token': otherToken } })).status, 404);
    assert.equal((await call(`/api/v1/devices/customer/${owner.id}`)).status, 401);
    assert.equal((await call(`/api/v1/devices/customer/${owner.id}`, { headers: { 'X-Customer-Token': otherToken } })).status, 401);

    const own = await call(`/api/v1/devices/${device.id}`, { headers: { 'X-Customer-Token': ownerToken } });
    assert.equal(own.status, 200);
    assert.equal(own.body.id, device.id);
    assert.equal((await call(`/api/v1/devices/${device.id}`, { headers: admin })).status, 200);
    assert.equal((await call(`/api/v1/devices/${device.id}`, { headers: { 'X-Device-Token': device.deviceToken } })).status, 200);

    const list = await call(`/api/v1/devices/customer/${owner.id}`, { headers: { 'X-Customer-Token': ownerToken } });
    assert.equal(list.status, 200);
    assert.equal(list.body.count, 1);
  });

  test('M6: check-user no longer returns the internal customer id', async () => {
    customerRepo.create({ merchantId: MERCHANT_ID, name: 'Checked', email: 'checked@example.com', mobileNumber: '9000000003' });
    const res = await call('/api/v1/customer/check-user', { method: 'POST', body: { mobileNumber: '9000000003' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.exists, true);
    assert.equal(res.body.customer.id, undefined);
  });

  test('M9: /expire refuses to expire a session whose window has not elapsed; trigger-hook sanitizes the action label', async () => {
    const created = await call('/api/v1/payments', { method: 'POST', headers: admin, body: { orderId: `AC-${Date.now()}`, amount: '10.00', autoActivate: true } });
    assert.equal(created.status, 201);
    const id = created.body.paymentId;
    assert.equal(created.body.status, 'ACTIVE');

    const early = await call(`/api/v1/checkout/${id}/expire`, { method: 'POST' });
    assert.equal(early.status, 409);
    assert.equal(early.body.code, 'NOT_EXPIRED');
    const stillActive = await call(`/api/v1/checkout/${id}/state`);
    assert.equal(stillActive.body.status, 'ACTIVE');

    const hook = await call(`/api/v1/checkout/${id}/trigger-hook`, {
      method: 'POST',
      headers: admin,
      body: { action: 'x\nFAKE_AUDIT_LINE', details: 'a'.repeat(5000) }
    });
    assert.equal(hook.status, 200);
    assert.equal(hook.body.action, 'ACTION');
    const rows = db.query(`SELECT action, details FROM audit_logs WHERE entity_id = ? AND action LIKE 'HOOK_%'`, [id]);
    assert.ok(rows.length >= 1);
    assert.ok(rows.every(r => !r.action.includes('FAKE_AUDIT_LINE') && r.details.length < 600));

    db.execute(`UPDATE payment_sessions SET expires_at = ? WHERE id = ?`, [new Date(Date.now() - 1000).toISOString(), id]);
    const late = await call(`/api/v1/checkout/${id}/expire`, { method: 'POST' });
    assert.equal(late.status, 200);
    assert.equal(late.body.status, 'EXPIRED');
  });

  test('M10: developer tools are blocked when YOUPI_MODE=production even if NODE_ENV is not', async () => {
    const prevMode = process.env.YOUPI_MODE;
    process.env.YOUPI_MODE = 'production';
    try {
      const res = await call('/api/v1/admin/dev/anything', { method: 'POST', headers: admin, body: {} });
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'DEV_TOOLS_DISABLED');
    } finally {
      process.env.YOUPI_MODE = prevMode;
    }
  });

  test('L2/L9: CORS preflight allows the credential headers, 404 does not echo the path, server-health tolerates a bad merchantId', async () => {
    const pre = await fetch(`http://localhost:${api.port}/api/v1/checkout/server-health`, { method: 'OPTIONS' });
    const allowed = pre.headers.get('access-control-allow-headers');
    for (const h of ['X-Merchant-Key', 'X-Customer-Token', 'X-Device-Token']) {
      assert.ok(allowed.includes(h), `${h} missing from allow-headers`);
    }

    const missing = await call('/api/v1/nope/<script>');
    assert.equal(missing.status, 404);
    assert.ok(!JSON.stringify(missing.body).includes('script'));

    const health = await call('/api/v1/checkout/server-health?merchantId=' + encodeURIComponent("x' OR '1'='1"));
    assert.equal(health.status, 200);
  });

  test('L3: logout clears the session cookie with Secure in production', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const res = await fetch(`http://localhost:${api.port}/api/v1/customer/logout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const cookie = res.headers.get('set-cookie') || '';
      assert.match(cookie, /youpi_session=;/);
      assert.match(cookie, /Max-Age=0/);
      assert.match(cookie, /Secure/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
