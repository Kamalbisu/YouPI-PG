import { test, describe, before, after } from 'node:test';
import { createTestDatabase } from '@youpi/db/testing';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { Database, CustomerRepository, CustomerSessionRepository, PaymentSessionRepository, MerchantRepository } from '@youpi/db';
import { startServer as startPaymentApi } from '../index.js';
import { authHeadersFor } from '../../../../scripts/test-support.js';

describe('YOUPI PG: Device Binding & Duplicate Session Detection', () => {
  let apiInstance;
  let baseUrl;
  let testDb;
  let merchantRepo;
  let sessionRepo;
  let customerRepo;
  let customerSessionRepo;
  let dev1TokenShared;
  const merchantId = '00000000-0000-0000-0000-000000000001';
  const receivingAccountId = '00000000-0000-0000-0000-000000000002';

  before(async () => {
    testDb = await createTestDatabase();
    merchantRepo = new MerchantRepository(testDb);
    sessionRepo = new PaymentSessionRepository(testDb);
    customerRepo = new CustomerRepository(testDb);
    customerSessionRepo = new CustomerSessionRepository(testDb);

    apiInstance = await startPaymentApi(6201, testDb);
    baseUrl = `http://localhost:${apiInstance.port}`;
  });

  after(async () => {
    if (apiInstance) await apiInstance.close();
    if (testDb) await testDb.destroy();
  });

  function request(path, options = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl);
      const req = http.request(url, {
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          'x-merchant-id': merchantId,
          ...authHeadersFor(path), ...(options.headers || {})
        }
      }, res => {
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
        req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
      }
      req.end();
    });
  }

  test('1. Device registration (POST /api/v1/devices/register) generates unique deviceId and JWT deviceToken', async () => {
    const res = await request('/api/v1/devices/register', {
      method: 'POST',
      body: {
        publicKey: 'mock-public-key-device-alpha',
        signals: {
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
          platform: 'Win32',
          screenSignature: '1920x1080x24',
          canvasSignature: 'test-canvas-hash-alpha'
        }
      }
    });

    assert.equal(res.status, 201);
    assert.ok(res.body.deviceId);
    assert.ok(res.body.deviceToken);
    assert.equal(res.body.success, true);
    assert.ok(res.body.deviceId.startsWith('dev_'));
  });

  test('2. Checkout session binds to the first device that accesses it', async () => {
    const createRes = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'ORDER_DEV_001',
        amount: 499.00,
        customerName: 'Aarav Sharma',
        customerPhone: '+919876543210',
        customerEmail: 'aarav@example.com'
      }
    });

    assert.equal(createRes.status, 201);
    const sessionId = createRes.body.paymentId;
    assert.ok(sessionId);

    const regRes1 = await request('/api/v1/devices/register', {
      method: 'POST',
      body: {
        publicKey: 'dev-1-public-key',
        signals: { userAgent: 'Device-1-Agent' }
      }
    });
    const dev1Id = regRes1.body.deviceId;
    const dev1Token = regRes1.body.deviceToken;
    dev1TokenShared = dev1Token;

    const stateRes1 = await request(`/api/v1/checkout/${sessionId}/state`, {
      headers: {
        'x-device-id': dev1Id,
        'x-device-token': dev1Token
      }
    });

    assert.equal(stateRes1.status, 200);
    assert.equal(stateRes1.body.paymentId, sessionId);
    assert.equal(stateRes1.body.deviceId, dev1Id);

    const row = await testDb.queryOne('SELECT device_id FROM payment_sessions WHERE id = ?', [sessionId]);
    assert.equal(row.device_id, dev1Id);
  });

  test('3. Same bound device can perform repeated requests without conflict', async () => {
    const row = await testDb.queryOne('SELECT id, device_id FROM payment_sessions WHERE order_id = ?', ['ORDER_DEV_001']);
    const sessionId = row.id;
    const dev1Id = row.device_id;

    const res = await request(`/api/v1/checkout/${sessionId}/state`, {
      headers: {
        'x-device-id': dev1Id,
        'x-device-token': dev1TokenShared
      }
    });
    assert.equal(res.status, 200);

    const methodRes = await request(`/api/v1/checkout/${sessionId}/select-method`, {
      method: 'POST',
      headers: {
        'x-device-id': dev1Id,
        'x-device-token': dev1TokenShared
      },
      body: { method: 'UPI' }
    });
    assert.equal(methodRes.status, 200);
  });

  test('4. Different device (dev-2) attempting to access session triggers DUPLICATE_SESSION_DETECTED (HTTP 409)', async () => {
    const row = await testDb.queryOne('SELECT id, device_id FROM payment_sessions WHERE order_id = ?', ['ORDER_DEV_001']);
    const sessionId = row.id;

    const regRes2 = await request('/api/v1/devices/register', {
      method: 'POST',
      body: {
        publicKey: 'dev-2-public-key',
        signals: { userAgent: 'Device-2-Agent' }
      }
    });
    const dev2Id = regRes2.body.deviceId;
    const dev2Token = regRes2.body.deviceToken;

    const conflictRes = await request(`/api/v1/checkout/${sessionId}/state`, {
      headers: {
        'x-device-id': dev2Id,
        'x-device-token': dev2Token
      }
    });

    assert.equal(conflictRes.status, 409);
    assert.equal(conflictRes.body.error, 'DUPLICATE_SESSION_DETECTED');
    assert.equal(conflictRes.body.action, 'END_SESSION_AND_CREATE_NEW');
    assert.ok(conflictRes.body.message.includes('another device'));
  });

  test('5. Non-bound device (dev-2) is blocked from taking payment actions', async () => {
    const row = await testDb.queryOne('SELECT id, device_id FROM payment_sessions WHERE order_id = ?', ['ORDER_DEV_001']);
    const sessionId = row.id;

    const resMethod = await request(`/api/v1/checkout/${sessionId}/select-method`, {
      method: 'POST',
      headers: { 'x-device-id': 'dev_unauthorized_999' },
      body: { method: 'COD' }
    });
    assert.equal(resMethod.status, 409);
    assert.equal(resMethod.body.error, 'DUPLICATE_SESSION_DETECTED');

    const resCod = await request(`/api/v1/checkout/${sessionId}/confirm-cod`, {
      method: 'POST',
      headers: { 'x-device-id': 'dev_unauthorized_999' }
    });
    assert.equal(resCod.status, 409);
    assert.equal(resCod.body.error, 'DUPLICATE_SESSION_DETECTED');
  });

  test('6. "End Session & Start New Payment" terminates the old session and creates a fresh session bound to the requesting device', async () => {
    const row = await testDb.queryOne('SELECT id, device_id FROM payment_sessions WHERE order_id = ?', ['ORDER_DEV_001']);
    const oldSessionId = row.id;

    const regNew = await request('/api/v1/devices/register', {
      method: 'POST',
      body: {
        publicKey: 'dev-recovery-replacement-888-pubkey',
        signals: { userAgent: 'Recovery-Device-Agent' }
      }
    });
    assert.equal(regNew.status, 201);
    const newDevId = regNew.body.deviceId;
    const newDevToken = regNew.body.deviceToken;

    const restartRes = await request(`/api/v1/checkout/${oldSessionId}/end-and-restart-payment`, {
      method: 'POST',
      headers: {
        'x-device-id': newDevId,
        'x-device-token': newDevToken
      },
      body: { deviceId: newDevId, deviceToken: newDevToken }
    });

    assert.equal(restartRes.status, 201);
    assert.equal(restartRes.body.success, true);
    assert.equal(restartRes.body.oldSessionId, oldSessionId);
    assert.ok(restartRes.body.newSessionId);
    assert.notEqual(restartRes.body.newSessionId, oldSessionId);
    assert.ok(restartRes.body.checkoutUrl.includes(restartRes.body.newSessionId));

    const oldSessionDb = await testDb.queryOne('SELECT status FROM payment_sessions WHERE id = ?', [oldSessionId]);
    assert.equal(oldSessionDb.status, 'CANCELLED');

    const newSessionDb = await testDb.queryOne('SELECT id, status, device_id, amount_paise, order_id FROM payment_sessions WHERE id = ?', [restartRes.body.newSessionId]);
    assert.ok(newSessionDb);
    assert.equal(newSessionDb.device_id, newDevId);
    assert.equal(newSessionDb.amount_paise, 49900);

    const newStateRes = await request(`/api/v1/checkout/${restartRes.body.newSessionId}/state`, {
      headers: {
        'x-device-id': newDevId,
        'x-device-token': newDevToken
      }
    });
    assert.equal(newStateRes.status, 200);
    assert.equal(newStateRes.body.paymentId, restartRes.body.newSessionId);
  });

  test('7. If a customer binds to a session, another session for the same customer triggers active session conflict', async () => {
    const cust = await customerRepo.create({
      merchantId,
      name: 'Concurrent User',
      email: 'concurrent@example.com',
      mobileNumber: '+919999888877'
    });
    const custSess = await customerSessionRepo.create({ customerId: cust.id });

    const s1Res = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'ORDER_CONC_1',
        amount: 250.00,
        customerName: 'Concurrent User',
        customerPhone: '+919999888877',
        customerEmail: 'concurrent@example.com'
      }
    });
    const s1Id = s1Res.body.paymentId;

    const bind1Res = await request(`/api/v1/checkout/${s1Id}/bind-customer`, {
      method: 'POST',
      body: { customerId: cust.id, token: custSess.token }
    });
    assert.equal(bind1Res.status, 200);

    const s2Res = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'ORDER_CONC_2',
        amount: 350.00,
        customerName: 'Concurrent User',
        customerPhone: '+919999888877',
        customerEmail: 'concurrent@example.com'
      }
    });
    const s2Id = s2Res.body.paymentId;

    const bind2Res = await request(`/api/v1/checkout/${s2Id}/bind-customer`, {
      method: 'POST',
      body: { customerId: cust.id, token: custSess.token }
    });

    assert.equal(bind2Res.body.hasActiveSessionConflict, true);
    assert.ok(bind2Res.body.conflictingSession);
    assert.equal(bind2Res.body.conflictingSession.paymentId, s1Id);
  });

  test('8. Prompt 64 Regression: Device A creates ACTIVE Session A, Device B attempts access, Device B chooses "End Session & Start New Payment" -> Session A becomes terminal, slot is released, and Device B\'s new Session B becomes ACTIVE immediately (not queued behind Session A)', async () => {
    await testDb.execute("UPDATE payment_sessions SET status = 'CANCELLED' WHERE status IN ('ACTIVE', 'PROCESSING', 'QUEUED')");
    await testDb.execute("UPDATE payment_receiving_accounts SET is_slot_busy = false, current_active_session_id = NULL");

    const regLaptop = await request('/api/v1/devices/register', {
      method: 'POST',
      body: { publicKey: 'key_laptop_p64', signals: { userAgent: 'Laptop Chrome' } }
    });
    const regMobile = await request('/api/v1/devices/register', {
      method: 'POST',
      body: { publicKey: 'key_mobile_p64', signals: { userAgent: 'Mobile Safari' } }
    });
    const devLaptopId = regLaptop.body.deviceId;
    const devLaptopToken = regLaptop.body.deviceToken;
    const devMobileId = regMobile.body.deviceId;
    const devMobileToken = regMobile.body.deviceToken;

    const custP64 = await customerRepo.create({
      merchantId,
      name: 'Mohit Laptop User',
      email: 'mohit.p64@example.com',
      mobileNumber: '+918796266491'
    });
    const custP64Sess = await customerSessionRepo.create({ customerId: custP64.id });

    const createRes = await request('/api/v1/payments', {
      method: 'POST',
      headers: {
        'x-device-id': devLaptopId,
        'x-device-token': devLaptopToken
      },
      body: {
        orderId: 'ORDER_P64_ALPHA',
        amount: 499.00,
        customerName: 'Mohit Laptop User',
        customerPhone: '+918796266491',
        customerEmail: 'mohit.p64@example.com',
        autoActivate: true
      }
    });

    assert.equal(createRes.status, 201);
    const sessionAId = createRes.body.paymentId;
    assert.ok(sessionAId);

    const bindResA = await request(`/api/v1/checkout/${sessionAId}/bind-customer`, {
      method: 'POST',
      headers: {
        'x-device-id': devLaptopId,
        'x-device-token': devLaptopToken
      },
      body: { customerId: custP64.id, token: custP64Sess.token }
    });
    assert.equal(bindResA.status, 200);

    const sessionADbBefore = await testDb.queryOne('SELECT id, status, queue_position, device_id, receiving_account_id FROM payment_sessions WHERE id = ?', [sessionAId]);
    assert.equal(sessionADbBefore.status, 'ACTIVE');
    assert.equal(sessionADbBefore.queue_position, 0);
    assert.equal(sessionADbBefore.device_id, devLaptopId);

    const receivingAccBefore = await testDb.queryOne('SELECT is_slot_busy, current_active_session_id FROM payment_receiving_accounts WHERE id = ?', [sessionADbBefore.receiving_account_id]);
    assert.equal(receivingAccBefore.is_slot_busy, true);
    assert.equal(receivingAccBefore.current_active_session_id, sessionAId);

    const accessResB = await request(`/api/v1/checkout/${sessionAId}/state`, {
      headers: {
        'x-device-id': devMobileId,
        'x-device-token': devMobileToken
      }
    });
    assert.equal(accessResB.status, 409);
    assert.equal(accessResB.body.error, 'DUPLICATE_SESSION_DETECTED');
    assert.equal(accessResB.body.action, 'END_SESSION_AND_CREATE_NEW');
    assert.equal(accessResB.body.boundDeviceId, devLaptopId);

    const restartRes = await request(`/api/v1/checkout/${sessionAId}/end-and-restart-payment`, {
      method: 'POST',
      headers: {
        'x-device-id': devMobileId,
        'x-device-token': devMobileToken
      },
      body: {
        deviceId: devMobileId,
        deviceToken: devMobileToken,
        conflictingSessionId: sessionAId
      }
    });

    assert.equal(restartRes.status, 201);
    assert.equal(restartRes.body.success, true);
    assert.equal(restartRes.body.oldSessionId, sessionAId);
    assert.ok(restartRes.body.newSessionId);
    assert.notEqual(restartRes.body.newSessionId, sessionAId);

    assert.equal(restartRes.body.status, 'ACTIVE', 'New session on Device B must become ACTIVE immediately');
    assert.equal(restartRes.body.queuePosition, 0, 'New session must have queuePosition 0, not queued');

    const sessionADbAfter = await testDb.queryOne('SELECT status, completed_at FROM payment_sessions WHERE id = ?', [sessionAId]);
    assert.equal(sessionADbAfter.status, 'CANCELLED');
    assert.ok(sessionADbAfter.completed_at);

    const receivingAccAfter = await testDb.queryOne('SELECT is_slot_busy, current_active_session_id FROM payment_receiving_accounts WHERE id = ?', [sessionADbBefore.receiving_account_id]);
    assert.equal(receivingAccAfter.is_slot_busy, true);
    assert.equal(receivingAccAfter.current_active_session_id, restartRes.body.newSessionId);

    const sessionBDb = await testDb.queryOne('SELECT id, status, queue_position, device_id FROM payment_sessions WHERE id = ?', [restartRes.body.newSessionId]);
    assert.equal(sessionBDb.status, 'ACTIVE');
    assert.equal(sessionBDb.queue_position, 0);
    assert.equal(sessionBDb.device_id, devMobileId);

    const stateB = await request(`/api/v1/checkout/${restartRes.body.newSessionId}/state`, {
      headers: {
        'x-device-id': devMobileId,
        'x-device-token': devMobileToken
      }
    });
    assert.equal(stateB.status, 200);
    assert.equal(stateB.body.status, 'ACTIVE');
    assert.equal(stateB.body.queuePosition, 0);
    assert.equal(stateB.body.canClickPaymentDone, true);
  });

  test('9. Prompt 64 Queue Invariant: When Session A is terminated, existing queued Customer C is promoted to ACTIVE, and new Session B is queued at position 1', async () => {
    await testDb.execute("UPDATE payment_sessions SET status = 'CANCELLED' WHERE status IN ('ACTIVE', 'PROCESSING', 'QUEUED')");
    await testDb.execute("UPDATE payment_receiving_accounts SET is_slot_busy = false, current_active_session_id = NULL");

    const regL = await request('/api/v1/devices/register', {
      method: 'POST',
      body: { publicKey: 'key_laptop_p64_q9', signals: { userAgent: 'Laptop Q9' } }
    });
    const regM = await request('/api/v1/devices/register', {
      method: 'POST',
      body: { publicKey: 'key_mobile_p64_q9', signals: { userAgent: 'Mobile Q9' } }
    });
    const regC = await request('/api/v1/devices/register', {
      method: 'POST',
      body: { publicKey: 'key_other_customer_q9', signals: { userAgent: 'Customer C Q9' } }
    });

    const devLId = regL.body.deviceId;
    const devLToken = regL.body.deviceToken;
    const devMId = regM.body.deviceId;
    const devMToken = regM.body.deviceToken;
    const devCId = regC.body.deviceId;
    const devCToken = regC.body.deviceToken;

    const sARes = await request('/api/v1/payments', {
      method: 'POST',
      headers: {
        'x-device-id': devLId,
        'x-device-token': devLToken
      },
      body: {
        orderId: 'ORDER_P64_Q9_A',
        amount: 500.00,
        customerName: 'User A',
        customerPhone: '+918888777701',
        customerEmail: 'usera@example.com',
        autoActivate: true
      }
    });
    const sAId = sARes.body.paymentId;

    const sADb = await testDb.queryOne('SELECT status, receiving_account_id FROM payment_sessions WHERE id = ?', [sAId]);
    assert.equal(sADb.status, 'ACTIVE');

    const sCRes = await request('/api/v1/payments', {
      method: 'POST',
      headers: {
        'x-device-id': devCId,
        'x-device-token': devCToken
      },
      body: {
        orderId: 'ORDER_P64_Q9_C',
        amount: 300.00,
        customerName: 'Queued Customer C',
        customerPhone: '+918888777702',
        customerEmail: 'userc@example.com',
        autoActivate: true
      }
    });
    const sCId = sCRes.body.paymentId;
    const sCDb = await testDb.queryOne('SELECT status, queue_position FROM payment_sessions WHERE id = ?', [sCId]);
    assert.equal(sCDb.status, 'QUEUED');
    assert.equal(sCDb.queue_position, 1);

    const restartRes = await request(`/api/v1/checkout/${sAId}/end-and-restart-payment`, {
      method: 'POST',
      headers: {
        'x-device-id': devMId,
        'x-device-token': devMToken
      },
      body: {
        deviceId: devMId,
        deviceToken: devMToken,
        conflictingSessionId: sAId
      }
    });

    assert.equal(restartRes.status, 201);
    assert.equal(restartRes.body.success, true);

    const sADbAfter = await testDb.queryOne('SELECT status FROM payment_sessions WHERE id = ?', [sAId]);
    assert.equal(sADbAfter.status, 'CANCELLED');

    const sCDbAfter = await testDb.queryOne('SELECT status, queue_position FROM payment_sessions WHERE id = ?', [sCId]);
    assert.equal(sCDbAfter.status, 'ACTIVE');
    assert.equal(sCDbAfter.queue_position, 0);

    const receivingAcc = await testDb.queryOne('SELECT is_slot_busy, current_active_session_id FROM payment_receiving_accounts WHERE id = ?', [sADb.receiving_account_id]);
    assert.equal(receivingAcc.is_slot_busy, true);
    assert.equal(receivingAcc.current_active_session_id, sCId);

    assert.equal(restartRes.body.status, 'QUEUED');
    assert.equal(restartRes.body.queuePosition, 1);

    const sBDb = await testDb.queryOne('SELECT status, queue_position, device_id FROM payment_sessions WHERE id = ?', [restartRes.body.newSessionId]);
    assert.equal(sBDb.status, 'QUEUED');
    assert.equal(sBDb.queue_position, 1);
    assert.equal(sBDb.device_id, devMId);
  });

  test('10. When duplicate payment session is detected and user starts new payment, admin queue receives info about ongoing session', async () => {
    await testDb.execute("UPDATE payment_sessions SET status = 'CANCELLED' WHERE status IN ('ACTIVE', 'PROCESSING', 'QUEUED')");
    await testDb.execute("UPDATE payment_receiving_accounts SET is_slot_busy = false, current_active_session_id = NULL");

    const regA = await request('/api/v1/devices/register', {
      method: 'POST',
      body: { publicKey: 'key_admin_sync_A', signals: { userAgent: 'Admin Sync A' } }
    });
    const regB = await request('/api/v1/devices/register', {
      method: 'POST',
      body: { publicKey: 'key_admin_sync_B', signals: { userAgent: 'Admin Sync B' } }
    });
    const devA = regA.body.deviceId;
    const devAToken = regA.body.deviceToken;
    const devB = regB.body.deviceId;
    const devBToken = regB.body.deviceToken;

    const createRes = await request('/api/v1/payments', {
      method: 'POST',
      headers: {
        'x-device-id': devA,
        'x-device-token': devAToken
      },
      body: {
        orderId: 'ORDER_ADMIN_SYNC_001',
        amount: 750.00,
        autoActivate: true
      }
    });
    assert.equal(createRes.status, 201);
    const session1Id = createRes.body.paymentId;

    const qRes1 = await request('/api/v1/admin/queue');
    assert.equal(qRes1.status, 200);
    assert.ok(qRes1.body.currentSlot);
    assert.equal(qRes1.body.currentSlot.id, session1Id);
    assert.equal(qRes1.body.currentSlot.orderId, 'ORDER_ADMIN_SYNC_001');

    const conflictRes = await request(`/api/v1/checkout/${session1Id}/state`, {
      headers: {
        'x-device-id': devB,
        'x-device-token': devBToken
      }
    });
    assert.equal(conflictRes.status, 409);
    assert.equal(conflictRes.body.error, 'DUPLICATE_SESSION_DETECTED');

    const restartRes = await request(`/api/v1/checkout/${session1Id}/end-and-restart-payment`, {
      method: 'POST',
      headers: {
        'x-device-id': devB,
        'x-device-token': devBToken
      },
      body: {
        deviceId: devB,
        deviceToken: devBToken,
        conflictingSessionId: session1Id
      }
    });
    assert.equal(restartRes.status, 201);
    assert.equal(restartRes.body.success, true);
    assert.equal(restartRes.body.status, 'ACTIVE');
    const newSessionId = restartRes.body.newSessionId;

    const qRes2 = await request('/api/v1/admin/queue');
    assert.equal(qRes2.status, 200);
    assert.ok(qRes2.body.currentSlot, 'Admin queue currentSlot must not be null');
    assert.equal(qRes2.body.currentSlot.id, newSessionId, 'Admin queue must show the new session ID');
    assert.equal(qRes2.body.currentSlot.status, 'ACTIVE', 'Admin queue currentSlot must be ACTIVE');
    assert.equal(qRes2.body.currentSlot.orderId, restartRes.body.orderId, 'Admin queue must show new session order ID');
    assert.ok(qRes2.body.currentSlot.expiresAt, 'Admin queue must have active timer expiresAt');
  });

  test('11. Issue #8 Security: Device binding cannot be bypassed by omitting X-Device-Id, X-Device-Token, or sending unregistered device IDs', async () => {
    const reg = await request('/api/v1/devices/register', {
      method: 'POST',
      body: { publicKey: 'key_issue8_bound_dev', signals: { userAgent: 'Issue8 Bound Agent' } }
    });
    const boundId = reg.body.deviceId;
    const boundToken = reg.body.deviceToken;

    const spoofPay = await request('/api/v1/payments', {
      method: 'POST',
      headers: { 'x-device-id': 'dev_unregistered_spoof_123' },
      body: { orderId: 'ORDER_ISSUE8_SPOOF', amount: 100.00 }
    });
    assert.equal(spoofPay.status, 401);
    const adhocRow = await testDb.queryOne('SELECT id FROM devices WHERE id = ?', ['dev_unregistered_spoof_123']);
    assert.equal(adhocRow, undefined, 'Must not auto-create adhoc_ device row');

    const missingTokenPay = await request('/api/v1/payments', {
      method: 'POST',
      headers: { 'x-device-id': boundId },
      body: { orderId: 'ORDER_ISSUE8_NOTOK', amount: 100.00 }
    });
    assert.equal(missingTokenPay.status, 401);

    const validPay = await request('/api/v1/payments', {
      method: 'POST',
      headers: { 'x-device-id': boundId, 'x-device-token': boundToken },
      body: { orderId: 'ORDER_ISSUE8_BOUND_1', amount: 299.00, autoActivate: true }
    });
    assert.equal(validPay.status, 201);
    const sid = validPay.body.paymentId;

    const omitIdState = await request(`/api/v1/checkout/${sid}/state`);
    assert.equal(omitIdState.status, 409);
    assert.equal(omitIdState.body.error, 'DUPLICATE_SESSION_DETECTED');

    const omitTokenState = await request(`/api/v1/checkout/${sid}/state`, {
      headers: { 'x-device-id': boundId }
    });
    assert.equal(omitTokenState.status, 409);
    assert.equal(omitTokenState.body.error, 'DUPLICATE_SESSION_DETECTED');

    const spoofInternal = await request(`/api/v1/checkout/${sid}/state`, {
      headers: { 'x-internal-render': 'true' }
    });
    assert.equal(spoofInternal.status, 409);
    assert.equal(spoofInternal.body.error, 'DUPLICATE_SESSION_DETECTED');

    const omitIdReCreate = await request('/api/v1/payments', {
      method: 'POST',
      body: { orderId: 'ORDER_ISSUE8_BOUND_1', amount: 299.00 }
    });
    assert.equal(omitIdReCreate.status, 409);
    assert.equal(omitIdReCreate.body.error, 'DUPLICATE_SESSION_DETECTED');
  });

  test('12. Issue #8 Security: /devices/register does not leak deviceToken for existing publicKey without signed challenge, and /devices/verify requires valid credentials and nonce+timestamp signatures', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1'
    });
    const publicKeySpkiBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

    const reg1 = await request('/api/v1/devices/register', {
      method: 'POST',
      body: { publicKey: publicKeySpkiBase64, signals: { userAgent: 'ECDSA-Agent' } }
    });
    assert.equal(reg1.status, 201);
    const deviceId = reg1.body.deviceId;
    const token1 = reg1.body.deviceToken;
    assert.ok(token1);

    const regDup = await request('/api/v1/devices/register', {
      method: 'POST',
      body: { publicKey: publicKeySpkiBase64, signals: { userAgent: 'Attacker-Replay' } }
    });
    assert.equal(regDup.status, 409);
    assert.equal(regDup.body.error, 'DEVICE_ALREADY_REGISTERED');
    assert.equal(regDup.body.deviceToken, undefined);
    assert.ok(regDup.body.challenge);

    const challengePayload = JSON.stringify({
      deviceId,
      challenge: regDup.body.challenge,
      nonce: crypto.randomBytes(12).toString('hex'),
      timestamp: Date.now()
    });
    const challengeSig = crypto.sign('SHA256', Buffer.from(challengePayload, 'utf8'), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363'
    }).toString('base64');

    const regRotated = await request('/api/v1/devices/register', {
      method: 'POST',
      body: {
        publicKey: publicKeySpkiBase64,
        challenge: regDup.body.challenge,
        payload: challengePayload,
        signature: challengeSig
      }
    });
    assert.equal(regRotated.status, 200);
    assert.ok(regRotated.body.deviceToken);
    assert.notEqual(regRotated.body.deviceToken, token1);
    const activeToken = regRotated.body.deviceToken;

    const verifyEmpty = await request('/api/v1/devices/verify', {
      method: 'POST',
      body: { deviceId }
    });
    assert.equal(verifyEmpty.status, 401);
    assert.equal(verifyEmpty.body.valid, false);

    const verifyOld = await request('/api/v1/devices/verify', {
      method: 'POST',
      body: { deviceId, deviceToken: token1 }
    });
    assert.equal(verifyOld.status, 401);
    assert.equal(verifyOld.body.valid, false);

    const verifyNew = await request('/api/v1/devices/verify', {
      method: 'POST',
      body: { deviceId, deviceToken: activeToken }
    });
    assert.equal(verifyNew.status, 200);
    assert.equal(verifyNew.body.valid, true);

    const staticPayload = 'static-message-without-nonce-or-timestamp';
    const staticSig = crypto.sign('SHA256', Buffer.from(staticPayload, 'utf8'), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363'
    }).toString('base64');
    const verifyStatic = await request('/api/v1/devices/verify', {
      method: 'POST',
      body: { deviceId, payload: staticPayload, signature: staticSig }
    });
    assert.equal(verifyStatic.status, 401);
    assert.equal(verifyStatic.body.valid, false);

    const freshPayload = JSON.stringify({
      deviceId,
      nonce: crypto.randomBytes(12).toString('hex'),
      timestamp: Date.now()
    });
    const freshSig = crypto.sign('SHA256', Buffer.from(freshPayload, 'utf8'), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363'
    }).toString('base64');

    const verifySig1 = await request('/api/v1/devices/verify', {
      method: 'POST',
      body: { deviceId, payload: freshPayload, signature: freshSig }
    });
    assert.equal(verifySig1.status, 200);
    assert.equal(verifySig1.body.valid, true);

    const verifySigReplay = await request('/api/v1/devices/verify', {
      method: 'POST',
      body: { deviceId, payload: freshPayload, signature: freshSig }
    });
    assert.equal(verifySigReplay.status, 401);
    assert.equal(verifySigReplay.body.valid, false);
  });

  test('13. Issue #8 Security: bind-customer rejects bare customerId, and cancel / retry / end-and-restart reject PROCESSING sessions and unauthenticated body.customerId', async () => {
    await testDb.execute("UPDATE payment_sessions SET status = 'CANCELLED' WHERE status IN ('ACTIVE', 'PROCESSING', 'QUEUED')");
    await testDb.execute("UPDATE payment_receiving_accounts SET is_slot_busy = false, current_active_session_id = NULL");

    const regDev = await request('/api/v1/devices/register', {
      method: 'POST',
      body: { publicKey: 'key_issue8_proc_guard', signals: { userAgent: 'ProcGuard Agent' } }
    });
    const devId = regDev.body.deviceId;
    const devToken = regDev.body.deviceToken;

    const cust = await customerRepo.create({
      merchantId,
      name: 'Protected Customer',
      email: 'protected.issue8@example.com',
      mobileNumber: '+919777666555'
    });

    const payRes = await request('/api/v1/payments', {
      method: 'POST',
      headers: { 'x-device-id': devId, 'x-device-token': devToken },
      body: { orderId: 'ORDER_ISSUE8_PROC_1', amount: 199.00, autoActivate: true }
    });
    assert.equal(payRes.status, 201);
    const sid = payRes.body.paymentId;

    const bareBind = await request(`/api/v1/checkout/${sid}/bind-customer`, {
      method: 'POST',
      headers: { 'x-device-id': devId, 'x-device-token': devToken },
      body: { customerId: cust.id }
    });
    assert.equal(bareBind.status, 401);

    const doneRes = await request(`/api/v1/checkout/${sid}/payment-done`, {
      method: 'POST',
      headers: { 'x-device-id': devId, 'x-device-token': devToken }
    });
    assert.equal(doneRes.status, 200);
    assert.equal(doneRes.body.status, 'PROCESSING');

    const cancelRes = await request(`/api/v1/checkout/${sid}/cancel`, {
      method: 'POST',
      headers: { 'x-device-id': devId, 'x-device-token': devToken }
    });
    assert.equal(cancelRes.status, 409);
    assert.equal(cancelRes.body.error, 'SESSION_PROCESSING');

    const retryRes = await request(`/api/v1/checkout/${sid}/retry-new-payment`, {
      method: 'POST',
      headers: { 'x-device-id': devId, 'x-device-token': devToken }
    });
    assert.equal(retryRes.status, 409);
    assert.equal(retryRes.body.error, 'SESSION_PROCESSING');

    const restartProc = await request(`/api/v1/checkout/${sid}/end-and-restart-payment`, {
      method: 'POST',
      headers: { 'x-device-id': devId, 'x-device-token': devToken },
      body: { deviceId: devId, deviceToken: devToken }
    });
    assert.equal(restartProc.status, 409);
    assert.equal(restartProc.body.error, 'SESSION_PROCESSING');

    const dbRow = await testDb.queryOne('SELECT status FROM payment_sessions WHERE id = ?', [sid]);
    assert.equal(dbRow.status, 'PROCESSING');

    await testDb.execute("UPDATE payment_sessions SET status = 'ACTIVE' WHERE id = ?", [sid]);
    const restartBareCust = await request(`/api/v1/checkout/${sid}/end-and-restart-payment`, {
      method: 'POST',
      headers: { 'x-device-id': devId, 'x-device-token': devToken },
      body: { deviceId: devId, deviceToken: devToken, customerId: cust.id }
    });
    assert.equal(restartBareCust.status, 401);
    assert.equal(restartBareCust.body.error, 'CUSTOMER_AUTH_REQUIRED');
  });
});
