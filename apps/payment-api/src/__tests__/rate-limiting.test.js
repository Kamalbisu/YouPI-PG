import '../../../../scripts/test-support.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Database, CustomerRepository, runMigrations } from '@youpi/db';
import { startServer as startPaymentApi } from '../index.js';
import { createRateLimiter, getClientIp } from '../rate-limit.js';

const LIMIT_ENV = {
  YOUPI_RATE_LIMIT_ANON_PAYMENTS_PER_MIN: '3',
  YOUPI_RATE_LIMIT_DEVICE_PER_MIN: '3',
  YOUPI_RATE_LIMIT_CHECK_USER_PER_MIN: '3',
  YOUPI_RATE_LIMIT_OTP_PER_MOBILE_PER_HOUR: '2',
  YOUPI_RATE_LIMIT_LOGIN_FAILURES_PER_15MIN: '3'
};

describe('rate-limit helpers', () => {
  test('limiter blocks after max and the key table stays bounded', () => {
    const limiter = createRateLimiter({ windowMs: 60000, max: 2, maxKeys: 5 });
    assert.equal(limiter.allow('a'), true);
    assert.equal(limiter.allow('a'), true);
    assert.equal(limiter.allow('a'), false);
    assert.equal(limiter.isLimited('a'), true);
    limiter.clear('a');
    assert.equal(limiter.isLimited('a'), false);
    for (let i = 0; i < 50; i++) limiter.allow(`k${i}`);
    assert.equal(limiter.allow('fresh'), true);
  });

  test('getClientIp ignores proxy headers unless explicitly trusted', () => {
    const req = { socket: { remoteAddress: '10.0.0.9' }, headers: { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.2, 10.0.0.9' } };
    const prev = process.env.YOUPI_TRUST_PROXY_HEADERS;
    try {
      delete process.env.YOUPI_TRUST_PROXY_HEADERS;
      assert.equal(getClientIp(req), '10.0.0.9');
      process.env.YOUPI_TRUST_PROXY_HEADERS = 'true';
      assert.equal(getClientIp(req), '203.0.113.7');
      delete req.headers['cf-connecting-ip'];
      assert.equal(getClientIp(req), '198.51.100.2');
      req.headers['x-forwarded-for'] = 'not-an-ip';
      assert.equal(getClientIp(req), '10.0.0.9');
    } finally {
      if (prev === undefined) delete process.env.YOUPI_TRUST_PROXY_HEADERS;
      else process.env.YOUPI_TRUST_PROXY_HEADERS = prev;
    }
  });
});

describe('route rate limits', () => {
  let api;
  let db;
  const saved = {};

  before(async () => {
    for (const [k, v] of Object.entries(LIMIT_ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    db = new Database({ inMemory: true });
    api = await startPaymentApi(6296, db);
  });

  after(async () => {
    await api.close();
    db.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function post(path, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(new URL(path, `http://localhost:${api.port}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers }
      }, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(data); } catch { parsed = data; }
          resolve({ status: res.statusCode, body: parsed, headers: res.headers });
        });
      });
      req.on('error', reject);
      req.write(JSON.stringify(body));
      req.end();
    });
  }

  test('anonymous payment creation is throttled per client address', async () => {
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const r = await post('/api/v1/payments', { orderId: `RL-${i}-${Date.now()}`, amount: '10.00' });
      statuses.push(r.status);
    }
    assert.ok(!statuses.slice(0, 3).includes(429), `first three must not be limited: ${statuses}`);
    assert.deepEqual(statuses.slice(3), [429, 429]);
  });

  test('device registration is throttled per client address', async () => {
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const r = await post('/api/v1/devices/register', { publicKey: `rl-key-${i}-${Date.now()}` });
      statuses.push(r.status);
    }
    assert.ok(!statuses.slice(0, 3).includes(429), `first three must not be limited: ${statuses}`);
    assert.deepEqual(statuses.slice(3), [429, 429]);
  });

  test('check-user is throttled per client address', async () => {
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const r = await post('/api/v1/customer/check-user', { mobileNumber: '9876543210' });
      statuses.push(r.status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
  });

  test('send-otp is capped per mobile number even when the cooldown is off', async () => {
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      const prev = process.env.OTP_RESEND_COOLDOWN_MS;
      process.env.OTP_RESEND_COOLDOWN_MS = '0';
      const r = await post('/api/v1/customer/send-otp', { mobileNumber: '9123456780', name: 'Rate Test', email: 'rate@example.com', isNewUser: true });
      if (prev === undefined) delete process.env.OTP_RESEND_COOLDOWN_MS;
      else process.env.OTP_RESEND_COOLDOWN_MS = prev;
      statuses.push(r.status);
    }
    assert.equal(statuses[0], 200);
    assert.equal(statuses[1], 200);
    assert.deepEqual(statuses.slice(2), [429, 429]);
  });

  test('login locks an account identifier after repeated failures, then accepts nothing until the window passes', async () => {
    const ident = 'lockout@example.com';
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const r = await post('/api/v1/customer/login', { identifier: ident, password: `wrong-pass-${i}` });
      statuses.push(r.status);
    }
    assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
  });
});

describe('OTP resend does not refill the guess budget', () => {
  test('setOtp keeps otp_attempts while the previous code is live and resets it once expired', () => {
    const db = new Database({ inMemory: true });
    runMigrations(db);
    try {
      const repo = new CustomerRepository(db);
      repo.create({ name: 'Otp Tester', email: 'otp@example.com', mobileNumber: '9000000001', password: 'secret123' });
      const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      repo.setOtp('9000000001', '111111', future);
      for (let i = 0; i < 3; i++) assert.equal(repo.verifyOtp('9000000001', '000000'), null);
      assert.equal(repo.findByMobile('9000000001').otpAttempts, 3);

      repo.setOtp('9000000001', '222222', future);
      assert.equal(repo.findByMobile('9000000001').otpAttempts, 3);

      const past = new Date(Date.now() - 1000).toISOString();
      db.execute('UPDATE customers SET otp_expires_at = ? WHERE mobile_number = ?', [past, '9000000001']);
      repo.setOtp('9000000001', '333333', future);
      assert.equal(repo.findByMobile('9000000001').otpAttempts, 0);
    } finally {
      db.close();
    }
  });
});
