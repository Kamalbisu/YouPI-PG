import { test, describe, before, after } from 'node:test';
import { createTestDatabase } from '@youpi/db/testing';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Database } from '@youpi/db';
import { startServer as startPaymentApi } from '../index.js';
import { PaymentStatus, PaymentMethod } from '@youpi/common';
import { authHeadersFor } from '../../../../scripts/test-support.js';

describe('COD Parallel Timer & UPI Queue Decoupling Suite', () => {
  let apiInstance;
  let baseUrl;
  let testDb;

  before(async () => {
    testDb = await createTestDatabase();
    apiInstance = await startPaymentApi(6196, testDb);
    baseUrl = `http://localhost:${apiInstance.port}`;

    const merchantId = '00000000-0000-0000-0000-000000000001';
    await testDb.execute(
      `UPDATE merchants
       SET branding = ?
       WHERE id = ?`,
      [
        JSON.stringify({
          sellingMode: 'ONLINE',
          enabledPaymentMethods: ['UPI', 'COD']
        }),
        merchantId
      ]
    );

    await testDb.execute(`
      UPDATE payment_receiving_accounts
      SET is_slot_busy = false, current_active_session_id = NULL
    `);

    await testDb.execute(
      `INSERT INTO customers (id, name, mobile_number, email, created_at, updated_at)
       VALUES (?, ?, ?, ?, now(), now())`,
      ['00000000-0000-0000-0000-000000000099', 'Rohan Verma', '9123456789', 'rohan@example.com']
    );
  });

  after(async () => {
    if (apiInstance?.close) {
      await apiInstance.close();
    }
    if (testDb?.close) {
      await testDb.destroy();
    }
  });

  function request(path, options = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl);
      const req = http.request(
        url,
        {
          method: options.method || 'GET',
          headers: {
            'Content-Type': 'application/json',
            ...authHeadersFor(path), ...(options.headers || {})
          }
        },
        res => {
          let data = '';
          res.on('data', chunk => (data += chunk));
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode, body: JSON.parse(data) });
            } catch {
              resolve({ status: res.statusCode, body: data });
            }
          });
        }
      );
      req.on('error', reject);
      if (options.body) {
        req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
      }
      req.end();
    });
  }

  test('Switching from UPI to COD decouples UPI queue, promotes queued customer, and starts parallel 5-min timer', async () => {
    const payA = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'ORD-UPI-TIMER-1',
        amount: '500.00',
        method: PaymentMethod.UPI,
        customerId: '00000000-0000-0000-0000-000000000099',
        autoActivate: true
      }
    });
    assert.equal(payA.status, 201);
    assert.equal(payA.body.status, PaymentStatus.ACTIVE);
    const sessionAId = payA.body.paymentId;

    const expiringSoon = new Date(Date.now() + 30000);
    await testDb.execute(`UPDATE payment_sessions SET expires_at = ? WHERE id = ?`, [expiringSoon.toISOString(), sessionAId]);

    const payB = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'ORD-UPI-QUEUE-2',
        amount: '750.00',
        method: PaymentMethod.UPI,
        autoActivate: true
      }
    });
    assert.equal(payB.status, 201);
    assert.equal(payB.body.status, PaymentStatus.QUEUED);
    assert.equal(payB.body.queuePosition, 1);
    const sessionBId = payB.body.paymentId;

    const switchRes = await request(`/api/v1/checkout/${sessionAId}/select-method`, {
      method: 'POST',
      body: { method: 'COD' }
    });
    assert.equal(switchRes.status, 200);
    assert.equal(switchRes.body.success, true);
    assert.equal(switchRes.body.method, 'COD');
    assert.equal(switchRes.body.status, PaymentStatus.ACTIVE);
    assert.ok(switchRes.body.timeRemainingSeconds >= 295 && switchRes.body.timeRemainingSeconds <= 300);

    const stateA = await request(`/api/v1/checkout/${sessionAId}/state`);
    assert.equal(stateA.body.method, 'COD');
    assert.equal(stateA.body.queuePosition, 0);

    const rowA = await testDb.queryOne(`SELECT * FROM payment_sessions WHERE id = ?`, [sessionAId]);
    assert.equal(rowA.receiving_account_id, null);
    assert.equal(rowA.method, 'COD');

    const stateB = await request(`/api/v1/checkout/${sessionBId}/state`);
    assert.equal(stateB.body.status, PaymentStatus.ACTIVE);
    assert.equal(stateB.body.queuePosition, 0);

    const adminQueue = await request('/api/v1/admin/queue');
    assert.equal(adminQueue.status, 200);
    assert.ok(adminQueue.body.currentSlot);
    assert.equal(adminQueue.body.currentSlot.id, sessionBId);
    assert.equal(adminQueue.body.currentSlot.orderId, 'ORD-UPI-QUEUE-2');

    await request(`/api/v1/checkout/${sessionBId}/cancel`, { method: 'POST' });
  });

  test('COD session expires after parallel 5-minute window without touching UPI queue', async () => {
    const payCod = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'ORD-COD-EXPIRE-1',
        amount: '450.00',
        method: PaymentMethod.COD,
        customerId: '00000000-0000-0000-0000-000000000099',
        autoActivate: true
      }
    });
    assert.equal(payCod.status, 201);
    const codSessionId = payCod.body.paymentId;

    const switchRes = await request(`/api/v1/checkout/${codSessionId}/select-method`, {
      method: 'POST',
      body: { method: 'COD' }
    });
    assert.equal(switchRes.status, 200);
    assert.equal(switchRes.body.timeRemainingSeconds, 300);

    await testDb.execute(`UPDATE payment_sessions SET expires_at = ? WHERE id = ? AND expires_at IS NOT NULL`, [new Date(Date.now() - 1000).toISOString(), codSessionId]);
    const expireRes = await request(`/api/v1/checkout/${codSessionId}/expire`, {
      method: 'POST'
    });
    assert.equal(expireRes.status, 200);
    assert.equal(expireRes.body.status, PaymentStatus.EXPIRED);

    const row = await testDb.queryOne(`SELECT * FROM payment_sessions WHERE id = ?`, [codSessionId]);
    assert.equal(row.status, PaymentStatus.EXPIRED);
    assert.equal(row.receiving_account_id, null);
  });
});
