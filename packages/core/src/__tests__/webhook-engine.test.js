import { test, describe, before, after } from 'node:test';
import { createTestDatabase } from '@youpi/db/testing';
import assert from 'node:assert/strict';
import http from 'node:http';
import '../../../../scripts/test-support.js';
import { Database, runMigrations, MerchantRepository, PaymentSessionRepository, ObservationRepository } from '@youpi/db';
import { WebhookEngine } from '../webhook-engine.js';
import { verifyHmac } from '@youpi/common';

describe('Webhook Engine Integration Tests', () => {
  let db;
  let merchantRepo;
  let sessionRepo;
  let webhookEngine;
  let receiverServer;
  let receiverPort;
  let receivedWebhooks = [];
  let shouldReceiverFail = false;

  before(async () => {
    db = await createTestDatabase();
    await runMigrations(db);
    merchantRepo = new MerchantRepository(db);
    sessionRepo = new PaymentSessionRepository(db);

    webhookEngine = new WebhookEngine({
      db,
      merchantRepo,
      maxRetries: 3
    });

    receiverServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        receivedWebhooks.push({
          headers: req.headers,
          body: JSON.parse(body || '{}')
        });

        if (shouldReceiverFail) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Merchant Error');
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ received: true }));
        }
      });
    });

    await new Promise(resolve => {
      receiverServer.listen(0, () => {
        receiverPort = receiverServer.address().port;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise(cb => receiverServer.close(cb));
    await db.destroy();
  });

  test('successfully dispatches HMAC-SHA256 signed webhook on payment event', async () => {
    const merchant = await merchantRepo.create({
      businessName: 'Webhook Test Store',
      slug: 'webhook-store',
      contactEmail: 'store@example.com',
      contactPhone: '9876543210',
      webhookUrl: `http://localhost:${receiverPort}/webhook`,
      webhookSecret: 'test_secret_for_merchant_signatures_123'
    });

    const session = await sessionRepo.create({
      merchantId: merchant.id,
      orderId: 'HOOK-ORD-001',
      amountPaise: 20000n
    });

    receivedWebhooks = [];
    shouldReceiverFail = false;

    const result = await webhookEngine.dispatch('SUCCESS', session);

    assert.equal(result.delivered, true);
    assert.equal(result.status, 200);
    assert.ok(result.deliveryId);

    assert.equal(receivedWebhooks.length, 1);
    const hook = receivedWebhooks[0];

    assert.equal(hook.headers['x-gateway-event'], 'SUCCESS');
    assert.ok(hook.headers['x-gateway-signature'].startsWith('sha256='));
    assert.equal(hook.headers['x-gateway-delivery-id'], result.deliveryId);

    assert.equal(hook.body.event, 'SUCCESS');
    assert.equal(hook.body.orderId, 'HOOK-ORD-001');
    assert.equal(hook.body.amount, '200.00');
    assert.equal(hook.body.amountPaise, 20000);

    const rawSig = hook.headers['x-gateway-signature'].replace('sha256=', '');
    const isValid = verifyHmac(JSON.stringify(hook.body), merchant.webhookSecret, rawSig);
    assert.equal(isValid, true);
    assert.ok('utr' in hook.body);

    const delivery = await db.queryOne('SELECT * FROM webhook_deliveries WHERE id = ?', [result.deliveryId]);
    assert.ok(delivery);
    assert.equal(delivery.is_successful, true);
    assert.equal(delivery.response_status, 200);
  });

  test('carries the bank reference (UTR) from the attributed observation', async () => {
    const merchant = await merchantRepo.create({
      businessName: 'UTR Store',
      slug: 'utr-store',
      contactEmail: 'utr@example.com',
      contactPhone: '9876543210',
      webhookUrl: `http://localhost:${receiverPort}/webhook-utr`,
      webhookSecret: 'test_secret_for_utr_signatures_123'
    });

    const session = await sessionRepo.create({
      merchantId: merchant.id,
      orderId: 'HOOK-ORD-UTR',
      amountPaise: 20000n,
      receivingAccountId: '00000000-0000-0000-0000-000000000002'
    });

    const observation = await new ObservationRepository(db).create({
      receivingAccountId: session.receivingAccountId,
      source: 'GOOGLE_MESSAGES',
      rawText: 'Rs 200.00 credited UPI ref 412345678901',
      amountPaise: 20000n,
      bankReferenceNumber: '412345678901',
      observedAt: new Date(),
      fingerprintHash: 'fp_utr_test'
    });
    await db.execute('UPDATE payment_sessions SET attributed_observation_id = ? WHERE id = ?', [observation.id, session.id]);

    receivedWebhooks = [];
    shouldReceiverFail = false;

    const result = await webhookEngine.dispatch('SUCCESS', await sessionRepo.findById(session.id));
    assert.equal(result.delivered, true);

    const hook = receivedWebhooks.find(h => h.body.orderId === 'HOOK-ORD-UTR');
    assert.ok(hook, 'webhook not received');
    assert.equal(hook.body.utr, '412345678901');

    const rawSig = hook.headers['x-gateway-signature'].replace('sha256=', '');
    assert.equal(verifyHmac(JSON.stringify(hook.body), merchant.webhookSecret, rawSig), true);

    for (const field of ['event', 'paymentId', 'orderId', 'amount', 'amountPaise', 'currency', 'method', 'utr', 'completedAt', 'metadata']) {
      assert.ok(field in hook.body, `missing documented webhook field: ${field}`);
    }
  });

  test('records failure and supports retry on merchant HTTP 500 error', async () => {
    const merchant = await merchantRepo.create({
      businessName: 'Failing Store',
      slug: 'failing-store',
      contactEmail: 'fail@example.com',
      contactPhone: '9876543210',
      webhookUrl: `http://localhost:${receiverPort}/webhook-fail`,
      webhookSecret: 'secret_abc_123'
    });

    const session = await sessionRepo.create({
      merchantId: merchant.id,
      orderId: 'HOOK-ORD-FAIL',
      amountPaise: 50000n
    });

    shouldReceiverFail = true;
    const result = await webhookEngine.dispatch('FAILED', session);

    assert.equal(result.delivered, false);
    assert.equal(result.status, 500);

    const delivery = await db.queryOne('SELECT * FROM webhook_deliveries WHERE id = ?', [result.deliveryId]);
    assert.equal(delivery.is_successful, false);
    assert.equal(delivery.attempt_count, 1);
    assert.ok(delivery.next_retry_at);

    shouldReceiverFail = false;
    const pastIso = new Date(Date.now() - 60000).toISOString();
    await db.execute('UPDATE webhook_deliveries SET next_retry_at = ? WHERE id = ?', [pastIso, result.deliveryId]);

    const retryResults = await webhookEngine.retryPending();
    assert.equal(retryResults.length, 1);
    assert.equal(retryResults[0].success, true);
    assert.equal(retryResults[0].attempt, 2);

    const updatedDelivery = await db.queryOne('SELECT * FROM webhook_deliveries WHERE id = ?', [result.deliveryId]);
    assert.equal(updatedDelivery.is_successful, true);

    const retried = receivedWebhooks.filter(h => h.body && h.body.orderId === 'HOOK-ORD-FAIL').pop();
    assert.ok(retried, 'retried webhook not received');
    const retrySig = retried.headers['x-gateway-signature'].replace('sha256=', '');
    assert.equal(verifyHmac(JSON.stringify(retried.body), merchant.webhookSecret, retrySig), true);
  });

  test('a retried delivery keeps the timestamp and delivery id of the original body', async () => {
    const merchant = await merchantRepo.create({
      businessName: 'Retry Consistency Store',
      slug: 'retry-consistency-store',
      contactEmail: 'retry@example.com',
      contactPhone: '9876543210',
      webhookUrl: `http://localhost:${receiverPort}/webhook-retry-consistency`,
      webhookSecret: 'test_secret_for_retry_consistency_123'
    });

    const session = await sessionRepo.create({
      merchantId: merchant.id,
      orderId: 'HOOK-ORD-RETRY-CONSISTENCY',
      amountPaise: 70000n
    });

    receivedWebhooks = [];
    shouldReceiverFail = false;

    const result = await webhookEngine.dispatch('SUCCESS', session);
    assert.equal(result.delivered, true);
    const first = receivedWebhooks[receivedWebhooks.length - 1];
    const firstBody = first.body;
    assert.ok(firstBody.timestamp, 'payload must carry a timestamp');
    assert.ok(firstBody.deliveryId, 'payload must carry a delivery id');

    await db.execute('UPDATE webhook_deliveries SET next_retry_at = ? WHERE id = ?', [
      new Date(Date.now() - 60000).toISOString(), result.deliveryId
    ]);
    await webhookEngine.retryPending();

    const retried = receivedWebhooks[receivedWebhooks.length - 1];
    assert.equal(String(retried.headers['x-gateway-timestamp']), String(firstBody.timestamp),
      'a retry must not recompute the timestamp, or it disagrees with the signed body');
    assert.equal(String(retried.headers['x-gateway-delivery-id']), String(firstBody.deliveryId),
      'a retry must keep the delivery id of the body it resends');
    assert.equal(JSON.stringify(retried.body), JSON.stringify(first.body), 'a retry must resend the identical body');

    const rawSig = retried.headers['x-gateway-signature'].replace('sha256=', '');
    assert.equal(verifyHmac(JSON.stringify(retried.body), merchant.webhookSecret, rawSig), true);
  });

  test('persists delivery failure record when merchant webhookSecret is missing', async () => {
    const merchantNoSecret = await merchantRepo.create({
      businessName: 'No Secret Store',
      slug: 'no-secret-store',
      contactEmail: 'nosecret@example.com',
      contactPhone: '9876543210',
      webhookUrl: `http://localhost:${receiverPort}/webhook-no-secret`,
      webhookSecret: 'temp_secret'
    });
    await db.execute("UPDATE merchants SET webhook_secret = '' WHERE id = ?", [merchantNoSecret.id]);

    const session = await sessionRepo.create({
      merchantId: merchantNoSecret.id,
      orderId: 'HOOK-ORD-NO-SEC',
      amountPaise: 10000n
    });

    const res = await webhookEngine.dispatch('SUCCESS', session);
    assert.equal(res.delivered, false);
    assert.equal(res.status, 500);
    assert.ok(res.deliveryId);

    const recorded = await db.queryOne('SELECT * FROM webhook_deliveries WHERE id = ?', [res.deliveryId]);
    assert.ok(recorded);
    assert.equal(recorded.is_successful, false);
    assert.equal(recorded.response_status, 500);
    assert.match(recorded.response_body, /webhookSecret is not configured/);
  });
});
