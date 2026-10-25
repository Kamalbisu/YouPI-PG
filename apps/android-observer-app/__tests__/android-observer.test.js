import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '@youpi/db';
import { startServer as startPaymentApi } from '../../../apps/payment-api/src/index.js';
import { AndroidObserverDriver } from '../driver.js';
import { PaymentStatus, resolveSecret, getAdminToken, generateHmac } from '@youpi/common';

describe('Android Payment Observer Integration Tests', () => {
  let apiInstance;
  let driver;
  let testDb;

  before(async () => {
    testDb = new Database({ inMemory: true });
    apiInstance = await startPaymentApi(6217, testDb);
    driver = new AndroidObserverDriver({
      apiBaseUrl: `http://localhost:${apiInstance.port}`,
      deviceName: 'Pixel 8 Pro Tester',
      deviceModel: 'Pixel 8 Pro'
    });
  });

  after(async () => {
    driver.stopHeartbeat();
    await apiInstance.close();
    testDb.close();
  });

  test('rejects pairing with invalid enrollment token', async () => {
    await assert.rejects(
      () => driver.pair('invalid_token_123'),
      /Device pairing failed/
    );
  });

  test('successfully pairs Android device with valid enrollment token', async () => {
    const enrollmentSecret = resolveSecret('android_enrollment_secret', 'ANDROID_ENROLLMENT_SECRET');
    const pairResult = await driver.pair(enrollmentSecret);

    assert.ok(pairResult.paired);
    assert.ok(pairResult.deviceId);
    assert.ok(pairResult.signingKey);

    assert.equal(driver.deviceId, pairResult.deviceId);
    assert.equal(driver.signingKey, pairResult.signingKey);
  });

  test('sends heartbeat acknowledging liveness', async () => {
    const hbResult = await driver.sendHeartbeat();
    assert.equal(hbResult.status, 'HEARTBEAT_ACK');
    assert.ok(hbResult.timestamp);
  });

  test('rejects observation with expired/drifted timestamp (Replay Protection)', async () => {
    // Timestamp 2 minutes in the past (> 60s drift)
    const oldTimestamp = Date.now() - 120000;
    const res = await driver.submitObservation({
      amount: '200.00',
      timestampOverride: oldTimestamp
    });

    assert.equal(res.status, 401);
    assert.ok(res.body.error.includes('validity window'));
  });

  test('submits valid HMAC-signed observation and confirms payment in Payment API', async () => {
    // 1. Create and activate a payment session for ₹350
    const session = apiInstance.app.context.sessionRepo.create({
      merchantId: '00000000-0000-0000-0000-000000000001',
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      orderId: 'ANDR-ORD-350',
      amountPaise: 35000n
    });

    apiInstance.app.context.queueEngine.enqueueOrActivate(session.id, '00000000-0000-0000-0000-000000000002');
    apiInstance.app.context.timingEngine.handlePaymentDone(session.id);

    // 2. Android observer submits observation for ₹350
    const res = await driver.submitObservation({
      amount: '350.00',
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      utr: 'UTR-ANDR-9876',
      senderVpa: 'customer@paytm',
      notificationText: 'Payment of ₹350 received from customer@paytm on PhonePe'
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.accepted, true);
    assert.equal(res.body.attribution.attributed, true);
    assert.equal(res.body.attribution.paymentSessionId, session.id);
    assert.equal(res.body.attribution.outcomeStatus, PaymentStatus.SUCCESS);

    // 3. Verify session in DB updated to SUCCESS
    const updated = apiInstance.app.context.sessionRepo.findById(session.id);
    assert.equal(updated.status, PaymentStatus.SUCCESS);
  });

  test('Issue #61: rejects notification observation when rawNotification has missing or empty package', async () => {
    const resWithoutPkg = await driver.submitObservation({
      amount: '100.00',
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      utr: 'UTR-MISSING-PKG',
      notificationText: 'Payment of ₹100 received from user@bank on UPI',
      package: ''
    });

    assert.equal(resWithoutPkg.status, 400);
    assert.match(resWithoutPkg.body.error, /must specify a valid package name/);
  });

  test('Issue #61: rejects notification observation from untrusted/unallowed package name', async () => {
    const resUntrusted = await driver.submitObservation({
      amount: '100.00',
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      utr: 'UTR-UNTRUSTED-PKG',
      notificationText: 'Payment of ₹100 received from fake@bank on FakeApp',
      package: 'com.attacker.fake.banking'
    });

    assert.equal(resUntrusted.status, 400);
    assert.match(resUntrusted.body.error, /Untrusted Android notification package/);
  });

  describe('device ingestion hardening', () => {
    const signedPost = async (bodyObj, { timestamp = Date.now().toString(), key } = {}) => {
      const body = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
      const signature = generateHmac(`${body}:${timestamp}`, key || driver.signingKey);
      const res = await fetch(`${driver.apiBaseUrl}/api/v1/observers/sms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Device-Id': driver.deviceId,
          'X-Timestamp': timestamp,
          'X-Signature': signature
        },
        body
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };

    test('rejects a replayed signed request even inside the drift window', async () => {
      const payload = { body: 'not a bank message', receivingAccountId: '00000000-0000-0000-0000-000000000002' };
      const timestamp = Date.now().toString();
      const first = await signedPost(payload, { timestamp });
      assert.notEqual(first.status, 401, 'first delivery must pass authentication');
      const second = await signedPost(payload, { timestamp });
      assert.equal(second.status, 401);
      assert.match(second.body.error, /replay/i);
    });

    test('rejects a receivingAccountId that does not belong to the device merchant', async () => {
      const res = await signedPost({
        body: 'Rs 10 credited UTR 123456789012',
        receivingAccountId: crypto.randomUUID()
      });
      assert.equal(res.status, 403);
      assert.match(res.body.error, /merchant/);
    });

    test('rejects a non-numeric amountPaise with 400 instead of crashing', async () => {
      const res = await signedPost({
        body: 'Rs 10 credited UTR 123456789012',
        receivingAccountId: '00000000-0000-0000-0000-000000000002',
        amountPaise: 'not-a-number'
      });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /amountPaise/);
    });

    test('rejects an oversized body before parsing it', async () => {
      const res = await fetch(`${driver.apiBaseUrl}/api/v1/observers/sms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Device-Id': driver.deviceId },
        body: JSON.stringify({ body: 'x'.repeat(200 * 1024) })
      });
      assert.equal(res.status, 413);
    });
  });

  describe('one-time pairing token', () => {
    test('QR carries a one-time token, not the enrollment secret, and it works once', async () => {
      const enrollmentSecret = resolveSecret('android_enrollment_secret', 'ANDROID_ENROLLMENT_SECRET');
      const qr = await (await fetch(`${driver.apiBaseUrl}/api/v1/admin/sms-gateway/pair-qr`, {
        headers: { Authorization: `Bearer ${getAdminToken()}` }
      })).json();
      assert.ok(qr.enrollmentToken);
      assert.notEqual(qr.enrollmentToken, enrollmentSecret);
      assert.ok(!JSON.stringify(qr).includes(enrollmentSecret), 'QR response must not contain the enrollment secret');

      const pair = () => fetch(`${driver.apiBaseUrl}/api/v1/pollers/android/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enrollmentToken: qr.enrollmentToken, deviceName: 'One-time test' })
      });
      assert.equal((await pair()).status, 200);
      assert.equal((await pair()).status, 401);
    });
  });
});
