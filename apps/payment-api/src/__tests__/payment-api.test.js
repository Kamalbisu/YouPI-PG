import { test, describe, before, after } from 'node:test';
import { createTestDatabase } from '@youpi/db/testing';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { Database, MerchantRepository } from '@youpi/db';
import { startServer } from '../index.js';
import { PaymentStatus, ObserverSource, verifyHmac } from '@youpi/common';
import { authHeadersFor, merchantHeaders } from '../../../../scripts/test-support.js';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

describe('Payment API End-to-End HTTP Integration Tests', () => {
  let serverInstance;
  let baseUrl;
  let testDb;
  let merchantSecret;
  let merchantWebhookUrl;

  before(async () => {
    testDb = await createTestDatabase();
    serverInstance = await startServer(6199, testDb);
    baseUrl = `http://localhost:${serverInstance.port}`;
    const seededMerchant = (await new MerchantRepository(testDb).findAll())[0];
    merchantSecret = seededMerchant.webhookSecret;
    merchantWebhookUrl = seededMerchant.webhookUrl;
  });

  after(async () => {
    await serverInstance.close();
    await testDb.destroy();
  });

  function request(path, options = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, options.baseUrl || baseUrl);
      const reqOpts = {
        method: options.method || 'GET',
        headers: authHeadersFor(path, options.headers || {})
      };

      const req = http.request(url, reqOpts, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          let body;
          try {
            body = JSON.parse(data);
          } catch {
            body = data;
          }
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
      });

      req.on('error', reject);

      if (options.body) {
        const payload = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
        req.setHeader('Content-Type', 'application/json');
        req.write(payload);
      }

      req.end();
    });
  }

  test('GET /health returns status UP and recovery statistics', async () => {
    const res = await request('/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'UP');
    assert.equal(res.body.service, 'payment-api');
    assert.ok(res.body.recoveryStats);
  });

  test('Complete payment lifecycle: creation, queue, payment-done, observation attribution & promotion', async () => {
    const payA = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'HTTP-ORD-001',
        amount: '200.00',
        currency: 'INR',
        returnUrl: 'https://merchant.example/success',
        autoActivate: true
      }
    });

    assert.equal(payA.status, 201);
    assert.ok(payA.body.paymentId);
    assert.equal(payA.body.status, PaymentStatus.ACTIVE);
    assert.equal(payA.body.queuePosition, 0);
    assert.ok(payA.body.checkoutUrl);

    const paymentIdA = payA.body.paymentId;

    const payB = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'HTTP-ORD-002',
        amount: '200.00',
        currency: 'INR',
        autoActivate: true
      }
    });

    assert.equal(payB.status, 201);
    assert.equal(payB.body.status, PaymentStatus.QUEUED);
    assert.equal(payB.body.queuePosition, 1);

    const paymentIdB = payB.body.paymentId;

    const stateA = await request(`/api/v1/checkout/${paymentIdA}/state`);
    assert.equal(stateA.status, 200);
    assert.equal(stateA.body.status, PaymentStatus.ACTIVE);
    assert.ok(stateA.body.upiUri.startsWith('upi://pay?'));
    assert.equal(stateA.body.canClickPaymentDone, true);
    assert.ok(stateA.body.timeRemainingSeconds > 0);

    const doneA = await request(`/api/v1/checkout/${paymentIdA}/payment-done`, {
      method: 'POST'
    });

    assert.equal(doneA.status, 200);
    assert.equal(doneA.body.status, PaymentStatus.PROCESSING);

    const obsRes = await request('/api/v1/pollers/events', {
      method: 'POST',
      body: {
        source: ObserverSource.GOOGLE_MESSAGES,
        receivingAccountId: '00000000-0000-0000-0000-000000000002',
        amount: '200.00',
        utr: 'UTR-HTTP-999',
        rawText: 'A/C 1234 credited by Rs 200.00 via UPI/UTR-HTTP-999',
        observedAt: new Date().toISOString()
      }
    });

    assert.equal(obsRes.status, 200);
    assert.equal(obsRes.body.attribution.attributed, true);
    assert.equal(obsRes.body.attribution.outcomeStatus, PaymentStatus.SUCCESS);
    assert.equal(obsRes.body.attribution.paymentSessionId, paymentIdA);

    const verifyA = await request(`/api/v1/payments/${paymentIdA}`);
    assert.equal(verifyA.status, 200);
    assert.equal(verifyA.body.status, 'SUCCESS');
    assert.ok(verifyA.body.completedAt);

    const stateB = await request(`/api/v1/checkout/${paymentIdB}/state`);
    assert.equal(stateB.status, 200);
    assert.equal(stateB.body.status, PaymentStatus.ACTIVE);
    assert.equal(stateB.body.queuePosition, 0);
    assert.ok(stateB.body.upiUri);
  });

  test('Customer registration, login, and decommissioned customer ticket routes', async () => {
    const regRes = await request('/api/v1/customer/register', {
      method: 'POST',
      body: {
        phoneNumber: '9988776655',
        fullName: 'Rohit Verma',
        password: 'Password123!'
      }
    });
    assert.equal(regRes.status, 201);
    assert.ok(regRes.body.customerId);

    const customerId = regRes.body.customerId;

    const loginRes = await request('/api/v1/customer/login', {
      method: 'POST',
      body: {
        phoneNumber: '9988776655',
        password: 'Password123!'
      }
    });
    assert.equal(loginRes.status, 200);
    assert.ok(loginRes.body.token);

    const ticketRes = await request('/api/v1/customer/tickets', {
      method: 'POST',
      body: {
        customerId,
        subject: 'Need help with UPI payment',
        message: 'My app closed while paying.'
      }
    });
    assert.equal(ticketRes.status, 404);
    assert.equal(ticketRes.body.error, 'Feature not available');

    const msgRes = await request('/api/v1/customer/tickets/ticket_1/messages', {
      method: 'POST',
      body: {
        senderType: 'CUSTOMER',
        senderId: customerId,
        message: 'Hello'
      }
    });
    assert.equal(msgRes.status, 404);
    assert.equal(msgRes.body.error, 'Feature not available');
  });

  test('Counter manual payment confirmation flow', async () => {
    const payCounter = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'COUNTER-ORD-777',
        amount: '150.00',
        method: 'CASH_COUNTER'
      }
    });
    assert.equal(payCounter.status, 201);
    const paymentId = payCounter.body.paymentId;

    const confirmRes = await request('/api/v1/admin/counter-confirm', {
      method: 'POST',
      body: {
        paymentId,
        operatorId: 'operator_desk_1',
        method: 'CASH_COUNTER'
      }
    });

    assert.equal(confirmRes.status, 200);
    assert.equal(confirmRes.body.confirmed, true);
    assert.equal(confirmRes.body.status, PaymentStatus.SUCCESS);

    const check = await request(`/api/v1/payments/${paymentId}`);
    assert.equal(check.body.status, 'SUCCESS');
  });

  test('Custom UPI ID persistence & dynamic QR injection', async () => {
    const prevActive = await serverInstance.app.context.sessionRepo.findCurrentActiveOrProcessing('00000000-0000-0000-0000-000000000002');
    if (prevActive) {
      await serverInstance.app.context.sessionRepo.transitionToTerminal(prevActive.id, PaymentStatus.CANCELLED);
    }

    const upiUpdateRes = await request('/api/v1/admin/upi-settings', {
      method: 'POST',
      body: {
        upiId: 'customstore@okhdfcbank',
        payeeName: 'Custom Store India'
      }
    });

    assert.equal(upiUpdateRes.status, 200);
    assert.equal(upiUpdateRes.body.success, true);
    assert.equal(upiUpdateRes.body.receivingAccount.upiId, 'customstore@okhdfcbank');

    const payRes = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'CUSTOM-UPI-ORD-1',
        amount: '350.00',
        autoActivate: true
      }
    });

    assert.equal(payRes.status, 201);
    const paymentId = payRes.body.paymentId;

    const stateRes = await request(`/api/v1/checkout/${paymentId}/state`);
    assert.equal(stateRes.status, 200);
    assert.equal(stateRes.body.payeeVpa, 'customstore@okhdfcbank');
    assert.ok(stateRes.body.upiUri.includes('customstore%40okhdfcbank') || stateRes.body.upiUri.includes('customstore@okhdfcbank'));
  });

  test('Payment method toggles and white-label branding persistence', async () => {
    const settingsRes = await request('/api/v1/admin/merchant-settings', {
      method: 'POST',
      body: {
        businessName: 'Astra Superstore',
        enabledPaymentMethods: ['UPI', 'CARD_COUNTER'],
        branding: {
          appName: 'AstraPay',
          primaryColor: '#7c3aed',
          logoUrl: 'https://cdn.example.com/astra-logo.png',
          sidebarNotice: 'Exclusive AstraPay UPI Partner',
          checkoutNotice: 'Flat 10% instant rebate on UPI',
          footerGuarantee: 'Protected by 256-Bit AstraShield'
        }
      }
    });

    assert.equal(settingsRes.status, 200);
    assert.equal(settingsRes.body.businessName, 'Astra Superstore');
    assert.deepEqual(settingsRes.body.branding.enabledPaymentMethods, ['UPI', 'CARD_COUNTER']);
    assert.equal(settingsRes.body.branding.logoUrl, 'https://cdn.example.com/astra-logo.png');
    assert.equal(settingsRes.body.branding.sidebarNotice, 'Exclusive AstraPay UPI Partner');

    const payRes = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'BRANDED-ORD-9',
        amount: '199.00',
        autoActivate: true
      }
    });

    const stateRes = await request(`/api/v1/checkout/${payRes.body.paymentId}/state`);
    assert.equal(stateRes.status, 200);
    assert.equal(stateRes.body.merchantName, 'Astra Superstore');
    assert.equal(stateRes.body.branding.appName, 'AstraPay');
    assert.equal(stateRes.body.branding.primaryColor, '#7c3aed');
    assert.equal(stateRes.body.branding.logoUrl, 'https://cdn.example.com/astra-logo.png');
    assert.equal(stateRes.body.branding.sidebarNotice, 'Exclusive AstraPay UPI Partner');
    assert.equal(stateRes.body.branding.checkoutNotice, 'Flat 10% instant rebate on UPI');
    assert.equal(stateRes.body.branding.footerGuarantee, 'Protected by 256-Bit AstraShield');
    assert.deepEqual(stateRes.body.enabledMethods, ['UPI', 'CARD_COUNTER']);
    assert.equal(stateRes.body.enabledMethods.includes('CASH_COUNTER'), false);
  });

  test('Customer auth binding and trigger-hook dispatch', async () => {
    const regRes = await request('/api/v1/customer/register', {
      method: 'POST',
      body: {
        phoneNumber: '9111222333',
        fullName: 'Astra VIP',
        password: 'Password123!'
      }
    });
    assert.equal(regRes.status, 201);
    const customerId = regRes.body.customerId;

    const payRes = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'AUTH-ORD-99',
        amount: '89.00'
      }
    });
    const paymentId = payRes.body.paymentId;

    const bindRes = await request(`/api/v1/checkout/${paymentId}/bind-customer`, {
      method: 'POST',
      body: { customerId, token: regRes.body.token }
    });
    assert.equal(bindRes.status, 200);
    assert.equal(bindRes.body.success, true);
    assert.equal(bindRes.body.customer.phoneNumber, '9111222333');

    const stateRes = await request(`/api/v1/checkout/${paymentId}/state`);
    assert.equal(stateRes.body.customer, null);

    const selfState = await request(`/api/v1/checkout/${paymentId}/state`, {
      headers: { 'x-customer-token': regRes.body.token }
    });
    assert.equal(selfState.body.customer.phoneNumber, '9111222333');

    const ownerState = await request(`/api/v1/checkout/${paymentId}/state`, {
      headers: { 'X-Merchant-Key': merchantSecret }
    });
    assert.equal(ownerState.body.customer.phoneNumber, '9111222333');

    const unauthHookRes = await request(`/api/v1/checkout/${paymentId}/trigger-hook`, {
      method: 'POST',
      body: {
        action: 'CANCEL_CLICKED',
        details: { reason: 'changed_mind' }
      }
    });
    assert.equal(unauthHookRes.status, 401);
    assert.equal(unauthHookRes.body.code, 'CUSTOMER_SESSION_REQUIRED');

    const hookRes = await request(`/api/v1/checkout/${paymentId}/trigger-hook`, {
      method: 'POST',
      headers: { 'x-customer-token': regRes.body.token },
      body: {
        action: 'CANCEL_CLICKED',
        details: { reason: 'changed_mind' }
      }
    });
    assert.equal(hookRes.status, 200);
    assert.equal(hookRes.body.success, true);
    assert.equal(hookRes.body.action, 'CANCEL_CLICKED');
  });

  test('Payment timer does not start until customer logs in or signs up', async () => {
    const prevActive = await serverInstance.app.context.sessionRepo.findCurrentActiveOrProcessing('00000000-0000-0000-0000-000000000002');
    if (prevActive) {
      await serverInstance.app.context.sessionRepo.transitionToTerminal(prevActive.id, PaymentStatus.CANCELLED);
    }

    const createRes = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'DEFERRED-TIMER-ORD-1',
        amount: '500.00'
      }
    });

    assert.equal(createRes.status, 201);
    assert.equal(createRes.body.status, 'INITIATED');
    const paymentId = createRes.body.paymentId;

    const stateBeforeAuth = await request(`/api/v1/checkout/${paymentId}/state`);
    assert.equal(stateBeforeAuth.status, 200);
    assert.equal(stateBeforeAuth.body.status, 'INITIATED');
    assert.equal(stateBeforeAuth.body.timeRemainingSeconds, 0);
    assert.equal(stateBeforeAuth.body.canClickPaymentDone, false);

    const regRes = await request('/api/v1/customer/register', {
      method: 'POST',
      body: {
        phoneNumber: '9444555666',
        fullName: 'Deferred User',
        password: 'Password123!'
      }
    });
    const customerId = regRes.body.customerId;

    const bindRes = await request(`/api/v1/checkout/${paymentId}/bind-customer`, {
      method: 'POST',
      body: { customerId, token: regRes.body.token }
    });

    assert.equal(bindRes.status, 200);
    assert.equal(bindRes.body.status, 'ACTIVE');
    assert.ok(bindRes.body.expiresAt);

    const stateAfterAuth = await request(`/api/v1/checkout/${paymentId}/state`);
    assert.equal(stateAfterAuth.body.status, 'ACTIVE');
    assert.ok(stateAfterAuth.body.timeRemainingSeconds > 280);
    assert.equal(stateAfterAuth.body.canClickPaymentDone, true);
  });

  test('Queue Sync Invariant: When Session A expires, queued Session B is immediately promoted to ACTIVE with armed timer', async () => {
    await testDb.execute(`
      UPDATE payment_sessions
      SET status = 'CANCELLED'
      WHERE receiving_account_id = ? AND status IN ('ACTIVE', 'PROCESSING', 'QUEUED')
    `, ['00000000-0000-0000-0000-000000000002']);
    await testDb.execute(`
      UPDATE payment_receiving_accounts
      SET is_slot_busy = false, current_active_session_id = NULL
      WHERE id = ?
    `, ['00000000-0000-0000-0000-000000000002']);

    const payA = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'QUEUE-SYNC-A',
        amount: '200.00',
        autoActivate: true
      }
    });
    assert.equal(payA.body.status, PaymentStatus.ACTIVE);
    assert.equal(payA.body.queuePosition, 0);

    const payB = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'QUEUE-SYNC-B',
        amount: '200.00',
        autoActivate: true
      }
    });
    assert.equal(payB.body.status, PaymentStatus.QUEUED);
    assert.equal(payB.body.queuePosition, 1);

    await testDb.execute(`UPDATE payment_sessions SET expires_at = ? WHERE id = ?`, [new Date(Date.now() - 1000).toISOString(), payA.body.paymentId]);
    const expireRes = await request(`/api/v1/checkout/${payA.body.paymentId}/expire`, {
      method: 'POST'
    });
    assert.equal(expireRes.status, 200);

    const checkA = await request(`/api/v1/payments/${payA.body.paymentId}`);
    assert.equal(checkA.body.status, 'EXPIRED');

    const checkB = await request(`/api/v1/checkout/${payB.body.paymentId}/state`);
    assert.equal(checkB.body.status, PaymentStatus.ACTIVE);
    assert.equal(checkB.body.queuePosition, 0);
    assert.ok(checkB.body.timeRemainingSeconds > 280);
    assert.ok(checkB.body.upiUri);
  });

  test('2-Level Payment Verification Engine: Upgrades verification tier from L1 (SMS) to L2 (Dual: SMS + Gmail)', async () => {
    await testDb.execute(`
      UPDATE payment_sessions
      SET status = 'CANCELLED'
      WHERE receiving_account_id = ? AND status IN ('ACTIVE', 'PROCESSING', 'QUEUED')
    `, ['00000000-0000-0000-0000-000000000002']);
    await testDb.execute(`
      UPDATE payment_receiving_accounts
      SET is_slot_busy = false, current_active_session_id = NULL
      WHERE id = ?
    `, ['00000000-0000-0000-0000-000000000002']);

    const payRes = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'VERIFY-TIER-ORD-1',
        amount: '650.00',
        autoActivate: true
      }
    });
    const paymentId = payRes.body.paymentId;

    await request(`/api/v1/checkout/${paymentId}/payment-done`, { method: 'POST' });

    const obs1 = await request('/api/v1/pollers/events', {
      method: 'POST',
      body: {
        source: 'GOOGLE_MESSAGES',
        receivingAccountId: '00000000-0000-0000-0000-000000000002',
        amount: '650.00',
        utr: 'UTR-TIER-001',
        rawText: 'A/C 1234 credited by Rs 650.00 via UPI/UTR-TIER-001',
        observedAt: new Date().toISOString()
      }
    });

    assert.equal(obs1.status, 200);
    assert.equal(obs1.body.attribution.attributed, true);
    assert.equal(obs1.body.attribution.verificationLevel, 1);
    assert.ok(obs1.body.attribution.verificationTag.includes('Single Verification') || obs1.body.attribution.verificationTag.includes('SMS'));

    const checkL1 = await request(`/api/v1/payments/${paymentId}`, { headers: merchantHeaders(merchantSecret) });
    assert.equal(checkL1.body.status, 'SUCCESS');
    assert.equal(checkL1.body.verificationLevel, 1);
    assert.deepEqual(checkL1.body.verificationSources, ['GOOGLE_MESSAGES']);

    const obs2 = await request('/api/v1/pollers/events', {
      method: 'POST',
      body: {
        source: 'GMAIL',
        receivingAccountId: '00000000-0000-0000-0000-000000000002',
        amount: '650.00',
        utr: 'UTR-TIER-001',
        rawText: 'Dear Customer, INR 650.00 credited to your account via UPI/UTR-TIER-001',
        observedAt: new Date().toISOString()
      }
    });

    assert.equal(obs2.status, 200);
    assert.equal(obs2.body.attribution.verificationLevel, 2);
    assert.ok(obs2.body.attribution.verificationTag.includes('Dual Verification'));

    const checkL2 = await request(`/api/v1/payments/${paymentId}`, { headers: merchantHeaders(merchantSecret) });
    assert.equal(checkL2.body.verificationLevel, 2);
    assert.ok(checkL2.body.verificationSources.includes('GOOGLE_MESSAGES'));
    assert.ok(checkL2.body.verificationSources.includes('GMAIL'));

    const adminCheck = await request('/api/v1/admin/payments');
    const pRecord = adminCheck.body.payments.find(p => p.id === paymentId);
    assert.ok(pRecord);
    assert.equal(pRecord.verificationLevel, 2);
    assert.equal(pRecord.verificationSources.length, 2);
  });

  test('Merchant webhook URL & secret persistence and HMAC-SHA256 signed event delivery', async () => {
    let receivedPayload = null;
    let receivedHeaders = null;
    let webhookResolve;
    const webhookReceivedPromise = new Promise(resolve => {
      webhookResolve = resolve;
    });

    const mockReceiver = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        receivedHeaders = req.headers;
        receivedPayload = body;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true }));
        webhookResolve();
      });
    });

    await new Promise(resolve => mockReceiver.listen(0, resolve));
    const receiverPort = mockReceiver.address().port;
    const receiverUrl = `http://localhost:${receiverPort}/api/webhook`;

    try {
      const customSecret = 'sec_wh_supersecret_key_778899';
      const updateRes = await request('/api/v1/admin/merchant-settings', {
        method: 'POST',
        body: {
          webhookUrl: receiverUrl,
          webhookSecret: customSecret
        }
      });

      assert.equal(updateRes.status, 200);
      assert.equal(updateRes.body.webhookUrl, receiverUrl);
      assert.equal(updateRes.body.webhookSecret, customSecret);

      const getMerchantRes = await request('/api/v1/admin/merchant-settings');
      assert.equal(getMerchantRes.status, 200);
      assert.equal(getMerchantRes.body.webhookUrl, receiverUrl);
      assert.equal(getMerchantRes.body.webhookSecret, customSecret);

      const getAllRes = await request('/api/v1/admin/all-settings');
      assert.equal(getAllRes.status, 200);
      assert.equal(getAllRes.body.webhookUrl, receiverUrl);
      assert.equal(getAllRes.body.webhookSecret, customSecret);

      const createRes = await request('/api/v1/payments', {
        method: 'POST',
        body: {
          orderId: 'WEBHOOK-TEST-ORD-1',
          amount: '450.00',
          method: 'CASH_COUNTER'
        }
      });
      assert.equal(createRes.status, 201);
      const paymentId = createRes.body.paymentId;

      const confirmRes = await request('/api/v1/admin/counter-confirm', {
        method: 'POST',
        body: {
          paymentId,
          operatorId: 'admin_wh_tester'
        }
      });
      assert.equal(confirmRes.status, 200);
      assert.equal(confirmRes.body.confirmed, true);

      await Promise.race([
        webhookReceivedPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Webhook delivery timed out')), 5000))
      ]);

      assert.ok(receivedPayload);
      assert.ok(receivedHeaders);

      assert.equal(receivedHeaders['x-gateway-event'], 'SUCCESS');
      assert.ok(receivedHeaders['x-gateway-signature'].startsWith('sha256='));
      assert.ok(receivedHeaders['x-gateway-delivery-id']);
      assert.ok(receivedHeaders['x-gateway-timestamp']);

      const parsedBody = JSON.parse(receivedPayload);
      assert.equal(parsedBody.event, 'SUCCESS');
      assert.equal(parsedBody.paymentId, paymentId);
      assert.equal(parsedBody.orderId, 'WEBHOOK-TEST-ORD-1');
      assert.equal(parsedBody.amount, '450.00');

      const sig = receivedHeaders['x-gateway-signature'].replace('sha256=', '');
      const validSig = verifyHmac(receivedPayload, customSecret, sig);
      assert.equal(validSig, true);

      const invalidSig = verifyHmac(receivedPayload, 'wrong_secret_123', sig);
      assert.equal(invalidSig, false);

      const partialUpdate = await request('/api/v1/admin/merchant-settings', {
        method: 'POST',
        body: {
          businessName: 'Preserved Store LLC'
        }
      });
      assert.equal(partialUpdate.status, 200);
      assert.equal(partialUpdate.body.businessName, 'Preserved Store LLC');
      assert.equal(partialUpdate.body.webhookUrl, receiverUrl);
      assert.equal(partialUpdate.body.webhookSecret, customSecret);

    } finally {
      await new Promise(cb => mockReceiver.close(cb));
    }
  });

  test('A delivery that failed is sent again by the retry daemon', async () => {
    const attempts = [];
    let firstAttemptResolve;
    const firstAttemptPromise = new Promise(resolve => { firstAttemptResolve = resolve; });

    const mockReceiver = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        attempts.push({ headers: req.headers, body });
        if (attempts.length === 1) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not ready' }));
          firstAttemptResolve();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true }));
      });
    });

    await new Promise(resolve => mockReceiver.listen(0, resolve));
    const receiverPort = mockReceiver.address().port;
    const receiverUrl = `http://localhost:${receiverPort}/api/webhook`;
    const customSecret = 'sec_wh_retry_test_key_9911';

    const retryDb = await createTestDatabase();
    const previousInterval = process.env.WEBHOOK_RETRY_INTERVAL_MS;
    process.env.WEBHOOK_RETRY_INTERVAL_MS = '1000';
    let retryServer = null;

    try {
      const retryPort = await freePort();
      retryServer = await startServer(retryPort, retryDb);
      const retryBase = `http://localhost:${retryServer.port}`;

      const updateRes = await request('/api/v1/admin/merchant-settings', {
        method: 'POST',
        body: { webhookUrl: receiverUrl, webhookSecret: customSecret },
        baseUrl: retryBase
      });
      assert.equal(updateRes.status, 200);

      const createRes = await request('/api/v1/payments', {
        method: 'POST',
        body: { orderId: 'WEBHOOK-RETRY-ORD-1', amount: '75.00', method: 'CASH_COUNTER' },
        baseUrl: retryBase
      });
      assert.equal(createRes.status, 201);
      const paymentId = createRes.body.paymentId;

      const confirmRes = await request('/api/v1/admin/counter-confirm', {
        method: 'POST',
        body: { paymentId, operatorId: 'admin_wh_retry_tester' },
        baseUrl: retryBase
      });
      assert.equal(confirmRes.status, 200);

      await Promise.race([
        firstAttemptPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('The first delivery never arrived')), 5000))
      ]);
      assert.equal(attempts.length, 1);

      let failedRow = null;
      const rowDeadline = Date.now() + 5000;
      while (Date.now() < rowDeadline) {
        failedRow = await retryDb.queryOne(
          'SELECT id, attempt_count, is_successful, next_retry_at FROM webhook_deliveries WHERE payment_id = ?',
          [paymentId]
        );
        if (failedRow) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(failedRow, 'the failed delivery was not recorded');
      assert.equal(failedRow.is_successful, false);
      assert.equal(failedRow.attempt_count, 1);
      assert.ok(failedRow.next_retry_at, 'a failed delivery must be scheduled for a retry');

      await retryDb.execute(
        'UPDATE webhook_deliveries SET next_retry_at = ? WHERE id = ?',
        [new Date(Date.now() - 1000).toISOString(), failedRow.id]
      );

      const retryDeadline = Date.now() + 10000;
      while (Date.now() < retryDeadline && attempts.length < 2) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(attempts.length, 2, 'the failed delivery was never retried');

      assert.equal(attempts[1].headers['x-gateway-delivery-id'], attempts[0].headers['x-gateway-delivery-id']);
      assert.equal(attempts[1].body, attempts[0].body);
      assert.equal(
        attempts[1].headers['x-gateway-signature'],
        attempts[0].headers['x-gateway-signature'],
        'the stored payload is re-signed, not re-built'
      );

      const settledRow = await retryDb.queryOne(
        'SELECT attempt_count, is_successful, response_status FROM webhook_deliveries WHERE id = ?',
        [failedRow.id]
      );
      assert.equal(settledRow.attempt_count, 2);
      assert.equal(settledRow.is_successful, true);
      assert.equal(settledRow.response_status, 200);
    } finally {
      if (retryServer) await retryServer.close();
      await retryDb.destroy();
      if (previousInterval === undefined) {
        delete process.env.WEBHOOK_RETRY_INTERVAL_MS;
      } else {
        process.env.WEBHOOK_RETRY_INTERVAL_MS = previousInterval;
      }
      await new Promise(cb => mockReceiver.close(cb));
    }
  });

  test('Auto-detection in ACTIVE state without Payment Done click: immediate SUCCESS, L1 to L2 upgrade, exactly 1 webhook', async () => {
    await testDb.execute(`
      UPDATE payment_sessions
      SET status = 'CANCELLED'
      WHERE receiving_account_id = ? AND status IN ('ACTIVE', 'PROCESSING', 'QUEUED')
    `, ['00000000-0000-0000-0000-000000000002']);
    await testDb.execute(`
      UPDATE payment_receiving_accounts
      SET is_slot_busy = false, current_active_session_id = NULL
      WHERE id = ?
    `, ['00000000-0000-0000-0000-000000000002']);

    let webhookDeliveries = [];
    const mockReceiver = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        webhookDeliveries.push({ headers: req.headers, body: JSON.parse(body || '{}') });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true }));
      });
    });

    await new Promise(resolve => mockReceiver.listen(0, resolve));
    const receiverPort = mockReceiver.address().port;
    const receiverUrl = `http://localhost:${receiverPort}/autodetect-webhook`;

    try {
      await request('/api/v1/admin/merchant-settings', {
        method: 'POST',
        body: {
          webhookUrl: receiverUrl,
          webhookSecret: 'secret_autodetect_test_9988'
        }
      });
      merchantSecret = (await new MerchantRepository(testDb).findAll())[0].webhookSecret;

      const payRes = await request('/api/v1/payments', {
        method: 'POST',
        body: {
          orderId: 'AUTODETECT-ORD-777',
          amount: '320.00',
          autoActivate: true
        }
      });
      assert.equal(payRes.status, 201);
      assert.equal(payRes.body.status, PaymentStatus.ACTIVE);
      const paymentId = payRes.body.paymentId;

      const checkBefore = await request(`/api/v1/payments/${paymentId}`);
      assert.equal(checkBefore.body.status, PaymentStatus.ACTIVE);

      const obs1 = await request('/api/v1/pollers/events', {
        method: 'POST',
        body: {
          source: 'GOOGLE_MESSAGES',
          receivingAccountId: '00000000-0000-0000-0000-000000000002',
          amount: '320.00',
          utr: 'UTR-NOCLICK-999',
          rawText: 'A/C 1234 credited by Rs 320.00 via UPI/UTR-NOCLICK-999',
          observedAt: new Date().toISOString()
        }
      });
      assert.equal(obs1.status, 200);
      assert.equal(obs1.body.attribution.attributed, true);
      assert.equal(obs1.body.attribution.verificationLevel, 1);

      const checkAfterObs1 = await request(`/api/v1/payments/${paymentId}`, { headers: merchantHeaders(merchantSecret) });
      assert.equal(checkAfterObs1.body.status, 'SUCCESS');
      assert.equal(checkAfterObs1.body.verificationLevel, 1);

      const stateAfterObs1 = await request(`/api/v1/checkout/${paymentId}/state`);
      assert.equal(stateAfterObs1.body.status, 'SUCCESS');

      await new Promise(r => setTimeout(r, 150));
      assert.equal(webhookDeliveries.length, 1);
      assert.equal(webhookDeliveries[0].body.event, 'SUCCESS');
      assert.equal(webhookDeliveries[0].body.orderId, 'AUTODETECT-ORD-777');
      assert.equal(webhookDeliveries[0].body.amount, '320.00');

      const obs2 = await request('/api/v1/pollers/events', {
        method: 'POST',
        body: {
          source: 'GMAIL',
          receivingAccountId: '00000000-0000-0000-0000-000000000002',
          amount: '320.00',
          utr: 'UTR-NOCLICK-999',
          rawText: 'Dear Customer, INR 320.00 credited to your account via UPI/UTR-NOCLICK-999',
          observedAt: new Date().toISOString()
        }
      });
      assert.equal(obs2.status, 200);
      assert.equal(obs2.body.attribution.verificationLevel, 2);

      const checkAfterObs2 = await request(`/api/v1/payments/${paymentId}`, { headers: merchantHeaders(merchantSecret) });
      assert.equal(checkAfterObs2.body.verificationLevel, 2);
      assert.deepEqual(checkAfterObs2.body.verificationSources.sort(), ['GMAIL', 'GOOGLE_MESSAGES'].sort());

      await new Promise(r => setTimeout(r, 150));
      assert.equal(webhookDeliveries.length, 1);

    } finally {
      await new Promise(cb => mockReceiver.close(cb));
    }
  });

  describe('Terminal Payment State HTTP Route Protections (Issue #4)', () => {
    test('POST /api/v1/checkout/:id/retry-new-payment rejects terminal sessions with HTTP 400', async () => {
      const prevActive = await serverInstance.app.context.sessionRepo.findCurrentActiveOrProcessing('00000000-0000-0000-0000-000000000002');
      if (prevActive) {
        const terminalStatus = prevActive.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.CANCELLED;
        await serverInstance.app.context.sessionRepo.transitionToTerminal(prevActive.id, terminalStatus);
      }

      const createRes = await request('/api/v1/payments', {
        method: 'POST',
        body: {
          orderId: 'ORD-RETRY-TERM',
          amount: '150.00',
          currency: 'INR',
          autoActivate: true
        }
      });
      assert.equal(createRes.status, 201);
      const paymentId = createRes.body.paymentId;

      const cancelRes = await request(`/api/v1/checkout/${paymentId}/cancel`, {
        method: 'POST'
      });
      assert.equal(cancelRes.status, 200);

      const retryRes = await request(`/api/v1/checkout/${paymentId}/retry-new-payment`, {
        method: 'POST'
      });
      assert.equal(retryRes.status, 400);
      assert.ok(retryRes.body.error.includes('Cannot retry payment for terminal session'));
    });

    test('POST /api/v1/checkout/:id/select-method rejects PROCESSING sessions with HTTP 400', async () => {
      const prevActive = await serverInstance.app.context.sessionRepo.findCurrentActiveOrProcessing('00000000-0000-0000-0000-000000000002');
      if (prevActive) {
        const terminalStatus = prevActive.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.CANCELLED;
        await serverInstance.app.context.sessionRepo.transitionToTerminal(prevActive.id, terminalStatus);
      }

      const createRes = await request('/api/v1/payments', {
        method: 'POST',
        body: {
          orderId: 'ORD-METHOD-PROC',
          amount: '180.00',
          currency: 'INR',
          autoActivate: true
        }
      });
      assert.equal(createRes.status, 201);
      const paymentId = createRes.body.paymentId;
      assert.equal(createRes.body.status, PaymentStatus.ACTIVE);

      const doneRes = await request(`/api/v1/checkout/${paymentId}/payment-done`, {
        method: 'POST'
      });
      assert.equal(doneRes.status, 200);
      assert.equal(doneRes.body.status, PaymentStatus.PROCESSING);

      const switchRes = await request(`/api/v1/checkout/${paymentId}/select-method`, {
        method: 'POST',
        body: { method: 'COD' }
      });
      assert.equal(switchRes.status, 400);
      assert.ok(switchRes.body.error.includes('Cannot switch payment method while payment is in PROCESSING status'));
    });

    test('POST /api/v1/checkout/:id/confirm-cod rejects PROCESSING sessions with HTTP 400', async () => {
      const prevActive = await serverInstance.app.context.sessionRepo.findCurrentActiveOrProcessing('00000000-0000-0000-0000-000000000002');
      if (prevActive) {
        const terminalStatus = prevActive.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.CANCELLED;
        await serverInstance.app.context.sessionRepo.transitionToTerminal(prevActive.id, terminalStatus);
      }

      const createRes = await request('/api/v1/payments', {
        method: 'POST',
        body: {
          orderId: 'ORD-COD-PROC',
          amount: '220.00',
          currency: 'INR',
          autoActivate: true
        }
      });
      assert.equal(createRes.status, 201);
      const paymentId = createRes.body.paymentId;
      assert.equal(createRes.body.status, PaymentStatus.ACTIVE);

      const doneRes = await request(`/api/v1/checkout/${paymentId}/payment-done`, {
        method: 'POST'
      });
      assert.equal(doneRes.status, 200);
      assert.equal(doneRes.body.status, PaymentStatus.PROCESSING);

      const codRes = await request(`/api/v1/checkout/${paymentId}/confirm-cod`, {
        method: 'POST'
      });
      assert.equal(codRes.status, 400);
      assert.ok(codRes.body.error.includes('Cannot place COD order while payment is in PROCESSING status'));
    });

    test('POST /api/v1/checkout/:id/confirm-cod rejects terminal sessions with HTTP 400', async () => {
      const prevActive = await serverInstance.app.context.sessionRepo.findCurrentActiveOrProcessing('00000000-0000-0000-0000-000000000002');
      if (prevActive) {
        const terminalStatus = prevActive.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.CANCELLED;
        await serverInstance.app.context.sessionRepo.transitionToTerminal(prevActive.id, terminalStatus);
      }

      const createRes = await request('/api/v1/payments', {
        method: 'POST',
        body: {
          orderId: 'ORD-COD-TERM',
          amount: '250.00',
          currency: 'INR',
          autoActivate: true
        }
      });
      assert.equal(createRes.status, 201);
      const paymentId = createRes.body.paymentId;

      await request(`/api/v1/checkout/${paymentId}/cancel`, {
        method: 'POST'
      });


      const codRes = await request(`/api/v1/checkout/${paymentId}/confirm-cod`, {
        method: 'POST'
      });
      assert.equal(codRes.status, 400);
      assert.ok(codRes.body.error.includes('Cannot place COD order for terminal session'));
    });
  });
});
