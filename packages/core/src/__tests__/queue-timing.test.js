import { test, describe, beforeEach, afterEach } from 'node:test';
import { createTestDatabase } from '@youpi/db/testing';
import assert from 'node:assert/strict';
import {
  Database,
  runMigrations,
  PaymentSessionRepository,
  ReceivingAccountRepository,
  AuditLogRepository
} from '@youpi/db';
import {
  QueueEngine,
  TimingEngine,
  RecoveryEngine
} from '../index.js';
import { PaymentStatus } from '@youpi/common';

describe('@youpi/core Queue & Timing Engine Tests', () => {
  let db;
  let sessionRepo;
  let accountRepo;
  let auditRepo;
  let queueEngine;
  let timingEngine;
  let recoveryEngine;
  let testAccount;
  let defaultMerchant;
  let events;

  beforeEach(async () => {
    db = await createTestDatabase();
    const seed = await runMigrations(db);
    defaultMerchant = seed.defaultMerchant;
    testAccount = { id: '00000000-0000-0000-0000-000000000002' };

    sessionRepo = new PaymentSessionRepository(db);
    accountRepo = new ReceivingAccountRepository(db);
    auditRepo = new AuditLogRepository(db);

    events = [];
    const eventEmitter = {
      emit: (event, payload) => events.push({ event, payload })
    };

    queueEngine = new QueueEngine({
      sessionRepo,
      accountRepo,
      eventEmitter,
      auditRepo
    });

    timingEngine = new TimingEngine({
      sessionRepo,
      queueEngine,
      eventEmitter,
      auditRepo,
      activeDurationMs: 100,
      processingDurationMs: 50
    });

    recoveryEngine = new RecoveryEngine({
      db,
      sessionRepo,
      accountRepo,
      queueEngine,
      timingEngine,
      auditRepo
    });
  });

  afterEach(async () => {
    await timingEngine.destroy();
    await db.destroy();
  });

  test('Queue Engine correctly assigns active slot and queued positions with wait estimates', async () => {
    const s1 = await sessionRepo.create({
      merchantId: defaultMerchant.id,
      receivingAccountId: testAccount.id,
      orderId: 'Q-ORD-1',
      amountPaise: 20000n
    });
    const s2 = await sessionRepo.create({
      merchantId: defaultMerchant.id,
      receivingAccountId: testAccount.id,
      orderId: 'Q-ORD-2',
      amountPaise: 20000n
    });
    const s3 = await sessionRepo.create({
      merchantId: defaultMerchant.id,
      receivingAccountId: testAccount.id,
      orderId: 'Q-ORD-3',
      amountPaise: 20000n
    });

    const res1 = await queueEngine.enqueueOrActivate(s1.id, testAccount.id, 300000);
    assert.equal(res1.status, PaymentStatus.ACTIVE);
    assert.equal(res1.queuePosition, 0);

    const res2 = await queueEngine.enqueueOrActivate(s2.id, testAccount.id, 300000);
    assert.equal(res2.status, PaymentStatus.QUEUED);
    assert.equal(res2.queuePosition, 1);

    const res3 = await queueEngine.enqueueOrActivate(s3.id, testAccount.id, 300000);
    assert.equal(res3.status, PaymentStatus.QUEUED);
    assert.equal(res3.queuePosition, 2);

    const wait2 = await queueEngine.calculateEstimatedWaitSeconds(testAccount.id, 1);
    const wait3 = await queueEngine.calculateEstimatedWaitSeconds(testAccount.id, 2);
    assert.ok(wait2 > 0);
    assert.ok(wait3 > wait2);
  });

  test('Timing Engine: 5-minute active window expires and auto-promotes next in queue', async () => {
    const s1 = await sessionRepo.create({
      merchantId: defaultMerchant.id,
      receivingAccountId: testAccount.id,
      orderId: 'TIM-ORD-1',
      amountPaise: 20000n
    });
    const s2 = await sessionRepo.create({
      merchantId: defaultMerchant.id,
      receivingAccountId: testAccount.id,
      orderId: 'TIM-ORD-2',
      amountPaise: 20000n
    });

    const res1 = await queueEngine.enqueueOrActivate(s1.id, testAccount.id, 50);
    await queueEngine.enqueueOrActivate(s2.id, testAccount.id, 50);

    await timingEngine.startActiveTimer(s1.id, res1.expiresAt);

    await new Promise(resolve => setTimeout(resolve, 70));

    const updatedS1 = await sessionRepo.findById(s1.id);
    assert.equal(updatedS1.status, PaymentStatus.EXPIRED);

    const updatedS2 = await sessionRepo.findById(s2.id);
    assert.equal(updatedS2.status, PaymentStatus.ACTIVE);
    assert.equal(updatedS2.queuePosition, 0);
  });

  test('Timing Engine: Payment Done starts 30-sec processing window, fails if no observation', async () => {
    const s1 = await sessionRepo.create({
      merchantId: defaultMerchant.id,
      receivingAccountId: testAccount.id,
      orderId: 'PROC-ORD-1',
      amountPaise: 20000n
    });

    await queueEngine.enqueueOrActivate(s1.id, testAccount.id, 300000);

    const procSession = await timingEngine.handlePaymentDone(s1.id);
    assert.equal(procSession.status, PaymentStatus.PROCESSING);
    assert.ok(procSession.processingExpiresAt);

    await new Promise(resolve => setTimeout(resolve, 70));

    const updatedS1 = await sessionRepo.findById(s1.id);
    assert.equal(updatedS1.status, PaymentStatus.FAILED);
  });

  test('Recovery Engine: crash recovery cleans up overdue sessions and promotes queued', async () => {
    const pastDate = new Date(Date.now() - 600000).toISOString();
    const s1 = await sessionRepo.create({
      merchantId: defaultMerchant.id,
      receivingAccountId: testAccount.id,
      orderId: 'CRASH-ORD-1',
      amountPaise: 20000n
    });
    await db.execute(`
      UPDATE payment_sessions
      SET status = ?, expires_at = ?, slot_acquired_at = ?
      WHERE id = ?
    `, [PaymentStatus.ACTIVE, pastDate, pastDate, s1.id]);
    await db.execute(`
      UPDATE payment_receiving_accounts
      SET is_slot_busy = true, current_active_session_id = ?
      WHERE id = ?
    `, [s1.id, testAccount.id]);

    const s2 = await sessionRepo.create({
      merchantId: defaultMerchant.id,
      receivingAccountId: testAccount.id,
      orderId: 'CRASH-ORD-2',
      amountPaise: 20000n,
      status: PaymentStatus.QUEUED,
      queuePosition: 1
    });

    const stats = await recoveryEngine.recover();
    assert.equal(stats.expiredCount, 1);
    assert.equal(stats.promotedCount, 1);

    const checkS1 = await sessionRepo.findById(s1.id);
    assert.equal(checkS1.status, PaymentStatus.EXPIRED);

    const checkS2 = await sessionRepo.findById(s2.id);
    assert.equal(checkS2.status, PaymentStatus.ACTIVE);
    assert.equal(checkS2.queuePosition, 0);
  });
  test('uses the configured payment window (PAYMENT_ACTIVE_WINDOW_MS) for activation and promotion', async () => {
    const engine = new QueueEngine({ sessionRepo, accountRepo, activeDurationMs: 60000 });
    const mk = async (orderId) => await sessionRepo.create({ merchantId: defaultMerchant.id, receivingAccountId: testAccount.id, orderId, amountPaise: 20000n });
    const a = await mk('WIN-ORD-1');
    const b = await mk('WIN-ORD-2');

    const t0 = Date.now();
    const first = await engine.enqueueOrActivate(a.id, testAccount.id);
    assert.equal(first.status, PaymentStatus.ACTIVE);
    const firstWindow = (await sessionRepo.findById(a.id)).expiresAt.getTime() - t0;
    assert.ok(firstWindow > 55000 && firstWindow < 65000, `first slot should get 60s, got ${firstWindow}ms`);

    assert.equal((await engine.enqueueOrActivate(b.id, testAccount.id)).status, PaymentStatus.QUEUED);
    await sessionRepo.transitionToTerminal(a.id, PaymentStatus.EXPIRED);
    const t1 = Date.now();
    const promoted = await engine.promoteNext(testAccount.id);
    assert.ok(promoted, 'queued session was not promoted');
    const promotedWindow = promoted.expiresAt.getTime() - t1;
    assert.ok(promotedWindow > 55000 && promotedWindow < 65000, `promoted slot should get 60s, got ${promotedWindow}ms`);
  });
});
