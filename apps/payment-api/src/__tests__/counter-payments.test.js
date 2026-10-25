import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Database } from '@youpi/db';
import { startServer as startPaymentApi } from '../index.js';
import { PaymentStatus, PaymentMethod } from '@youpi/common';
import { authHeadersFor } from '../../../../scripts/test-support.js';

describe('Phase 15: Counter Payments (Cash & Card at Counter)', () => {
  let apiInstance;
  let baseUrl;
  let testDb;

  before(async () => {
    testDb = new Database({ inMemory: true });
    apiInstance = await startPaymentApi(6194, testDb);
    baseUrl = `http://localhost:${apiInstance.port}`;
  });

  after(async () => {
    await apiInstance.close();
    testDb.close();
  });

  function request(path, options = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl);
      const req = http.request(url, {
        method: options.method || 'GET',
        headers: { 'Content-Type': 'application/json', ...authHeadersFor(path), ...(options.headers || {}) }
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
          resolve({ status: res.statusCode, body });
        });
      });

      req.on('error', reject);
      if (options.body) {
        req.write(JSON.stringify(options.body));
      }
      req.end();
    });
  }

  test('Cash at Counter does NOT block the digital UPI queue slot', async () => {
    const cashRes = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'TILL-CASH-101',
        amount: '120.00',
        method: PaymentMethod.CASH_COUNTER
      }
    });

    assert.equal(cashRes.status, 201);
    const cashPaymentId = cashRes.body.paymentId;

    const upiRes = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'DIGITAL-UPI-202',
        amount: '200.00',
        method: PaymentMethod.UPI,
        autoActivate: true
      }
    });

    assert.equal(upiRes.status, 201);
    assert.equal(upiRes.body.status, PaymentStatus.ACTIVE);
    assert.equal(upiRes.body.queuePosition, 0);

    const confirmRes = await request('/api/v1/admin/counter-confirm', {
      method: 'POST',
      body: {
        paymentId: cashPaymentId,
        operatorId: 'operator_till_1',
        method: PaymentMethod.CASH_COUNTER
      }
    });

    assert.equal(confirmRes.status, 200);
    assert.equal(confirmRes.body.confirmed, true);
    assert.equal(confirmRes.body.status, PaymentStatus.SUCCESS);

    const auditLogs = testDb.query(
      'SELECT * FROM audit_logs WHERE entity_id = ? AND action = ?',
      [cashPaymentId, 'COUNTER_MANUAL_PAYMENT_CONFIRMED']
    );

    assert.equal(auditLogs.length, 1);
    assert.equal(auditLogs[0].actor_id, 'operator_till_1');
    assert.equal(auditLogs[0].actor_type, 'ADMIN');
  });

  test('Card at Counter manual confirmation flow', async () => {
    const cardRes = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'POS-CARD-303',
        amount: '1850.00',
        method: PaymentMethod.CARD_COUNTER
      }
    });

    assert.equal(cardRes.status, 201);
    const cardPaymentId = cardRes.body.paymentId;

    const confirmRes = await request('/api/v1/admin/counter-confirm', {
      method: 'POST',
      body: {
        paymentId: cardPaymentId,
        operatorId: 'cashier_floor_2',
        method: PaymentMethod.CARD_COUNTER
      }
    });

    assert.equal(confirmRes.status, 200);
    assert.equal(confirmRes.body.status, PaymentStatus.SUCCESS);

    const check = await request(`/api/v1/payments/${cardPaymentId}`);
    assert.equal(check.body.status, 'SUCCESS');
    assert.equal(check.body.amount, '1850.00');
  });

  test('Customer switches from UPI to Cash at Counter via /select-method: unblocks UPI queue and reflects instructions', async () => {
    testDb.execute(`
      UPDATE payment_sessions
      SET status = 'CANCELLED'
      WHERE receiving_account_id = ? AND status IN ('ACTIVE', 'PROCESSING', 'QUEUED')
    `, ['00000000-0000-0000-0000-000000000002']);
    testDb.execute(`
      UPDATE payment_receiving_accounts
      SET is_slot_busy = 0, current_active_session_id = NULL
      WHERE id = ?
    `, ['00000000-0000-0000-0000-000000000002']);

    await request('/api/v1/admin/merchant-settings', {
      method: 'POST',
      body: {
        branding: {
          counterInstructions: 'Proceed to Cash Counter 4 and show Order ID to Cashier Raman'
        }
      }
    });

    const payA = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'SWITCH-ORD-1',
        amount: '300.00',
        method: PaymentMethod.UPI,
        autoActivate: true
      }
    });
    assert.equal(payA.status, 201);
    assert.equal(payA.body.status, PaymentStatus.ACTIVE);
    assert.equal(payA.body.queuePosition, 0);

    const payB = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'SWITCH-ORD-2',
        amount: '300.00',
        method: PaymentMethod.UPI,
        autoActivate: true
      }
    });
    assert.equal(payB.status, 201);
    assert.equal(payB.body.status, PaymentStatus.QUEUED);
    assert.equal(payB.body.queuePosition, 1);

    const switchRes = await request(`/api/v1/checkout/${payA.body.paymentId}/select-method`, {
      method: 'POST',
      body: { method: PaymentMethod.CASH_COUNTER }
    });
    assert.equal(switchRes.status, 200);
    assert.equal(switchRes.body.success, true);
    assert.equal(switchRes.body.method, PaymentMethod.CASH_COUNTER);
    assert.equal(switchRes.body.counterInstructions, 'Proceed to Cash Counter 4 and show Order ID to Cashier Raman');

    const checkA = await request(`/api/v1/checkout/${payA.body.paymentId}/state`);
    assert.equal(checkA.body.method, PaymentMethod.CASH_COUNTER);
    assert.equal(checkA.body.status, PaymentStatus.ACTIVE);
    assert.equal(checkA.body.branding.counterInstructions, 'Proceed to Cash Counter 4 and show Order ID to Cashier Raman');

    const checkB = await request(`/api/v1/checkout/${payB.body.paymentId}/state`);
    assert.equal(checkB.body.status, PaymentStatus.ACTIVE);
    assert.equal(checkB.body.queuePosition, 0);

    const adminPayments = await request('/api/v1/admin/payments');
    const counterReq = adminPayments.body.payments.find(p => p.id === payA.body.paymentId);
    assert.ok(counterReq);
    assert.equal(counterReq.method, PaymentMethod.CASH_COUNTER);
    assert.equal(counterReq.status, 'ACTIVE');

    await request(`/api/v1/checkout/${payB.body.paymentId}/cancel`, { method: 'POST' });
  });

  test('Merchant declines counter payment via /counter-decline: updates to FAILED, broadcasts status_change, logs audit', async () => {
    const cardRes = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'DECLINE-CARD-99',
        amount: '750.00',
        method: PaymentMethod.CARD_COUNTER
      }
    });
    assert.equal(cardRes.status, 201);
    const paymentId = cardRes.body.paymentId;

    const declineRes = await request('/api/v1/admin/counter-decline', {
      method: 'POST',
      body: {
        paymentId,
        operatorId: 'operator_desk_2',
        reason: 'POS card transaction declined by customer bank'
      }
    });

    assert.equal(declineRes.status, 200);
    assert.equal(declineRes.body.declined, true);
    assert.equal(declineRes.body.status, PaymentStatus.FAILED);
    assert.equal(declineRes.body.reason, 'POS card transaction declined by customer bank');

    const checkPayment = await request(`/api/v1/payments/${paymentId}`);
    assert.equal(checkPayment.body.status, PaymentStatus.FAILED);

    const checkState = await request(`/api/v1/checkout/${paymentId}/state`);
    assert.equal(checkState.body.status, PaymentStatus.FAILED);

    const auditLogs = testDb.query(
      'SELECT * FROM audit_logs WHERE entity_id = ? AND action = ?',
      [paymentId, 'COUNTER_MANUAL_PAYMENT_DECLINED']
    );
    assert.equal(auditLogs.length, 1);
    assert.equal(auditLogs[0].actor_id, 'operator_desk_2');
    assert.equal(auditLogs[0].actor_type, 'ADMIN');
  });
});
