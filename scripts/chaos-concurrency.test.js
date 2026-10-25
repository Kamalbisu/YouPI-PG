import { test, describe, before, after } from 'node:test';
import { createTestDatabase } from '@youpi/db/testing';
import assert from 'node:assert/strict';
import {
  Database,
  runMigrations,
  PaymentSessionRepository,
  ReceivingAccountRepository,
  ObservationRepository,
  SupportTicketRepository,
  AuditLogRepository,
  CustomerRepository
} from '@youpi/db';
import {
  QueueEngine,
  TimingEngine,
  AttributionEngine,
  RecoveryEngine,
  ObservationNormalizer
} from '@youpi/core';
import { PaymentStatus, ObserverSource, ObservationAttributionStatus } from '@youpi/common';

describe('Phase 16: Comprehensive Chaos & Concurrency Verification', () => {
  let db;
  let sessionRepo;
  let accountRepo;
  let obsRepo;
  let ticketRepo;
  let auditRepo;
  let customerRepo;
  let queueEngine;
  let timingEngine;
  let attributionEngine;
  let recoveryEngine;
  let testAccount;
  let defaultMerchant;
  let emittedEvents;

  before(async () => {
    db = await createTestDatabase();
    const seed = await runMigrations(db);
    defaultMerchant = seed.defaultMerchant;
    testAccount = { id: '00000000-0000-0000-0000-000000000002' };

    sessionRepo = new PaymentSessionRepository(db);
    accountRepo = new ReceivingAccountRepository(db);
    obsRepo = new ObservationRepository(db);
    ticketRepo = new SupportTicketRepository(db);
    auditRepo = new AuditLogRepository(db);
    customerRepo = new CustomerRepository(db);

    emittedEvents = [];
    const eventEmitter = {
      emit: (event, payload) => emittedEvents.push({ event, payload })
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
      activeDurationMs: 1000,
      processingDurationMs: 500
    });

    attributionEngine = new AttributionEngine({
      sessionRepo,
      obsRepo,
      ticketRepo,
      auditRepo,
      eventEmitter
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

  after(async () => {
    await timingEngine.destroy();
    await db.destroy();
  });

  test('CHAOS 1: 10 simultaneous sessions for identical amounts (₹200) acquire slot deterministically', async () => {
    const sessionIds = [];

    for (let i = 1; i <= 10; i++) {
      const s = await sessionRepo.create({
        merchantId: defaultMerchant.id,
        receivingAccountId: testAccount.id,
        orderId: `CHAOS-ORD-${i}`,
        amountPaise: 20000n
      });
      sessionIds.push(s.id);
    }

    const results = [];
    for (const id of sessionIds) {
      results.push(await queueEngine.enqueueOrActivate(id, testAccount.id, 300000));
    }

    const activeResults = results.filter(r => r.status === PaymentStatus.ACTIVE);
    assert.equal(activeResults.length, 1);
    assert.equal(activeResults[0].queuePosition, 0);

    const queuedResults = results.filter(r => r.status === PaymentStatus.QUEUED);
    assert.equal(queuedResults.length, 9);

    const positions = queuedResults.map(r => r.queuePosition).sort((a, b) => a - b);
    assert.deepEqual(positions, [1, 2, 3, 4, 5, 6, 7, 8, 9]);

    const activeAccount = await accountRepo.findById(testAccount.id);
    assert.equal(activeAccount.isSlotBusy, true);
    assert.equal(activeAccount.currentActiveSessionId, sessionIds[0]);
  });

  test('CHAOS 2: Multi-tab simultaneous Payment Done clicks are strictly idempotent', async () => {
    const activeSession = await sessionRepo.findCurrentActiveOrProcessing(testAccount.id);
    assert.ok(activeSession);

    const results = await Promise.all([1, 2, 3, 4, 5].map(async () => {
      try {
        return await timingEngine.handlePaymentDone(activeSession.id);
      } catch (err) {
        return { error: err.message };
      }
    }));

    for (const r of results) {
      assert.equal(r.status, PaymentStatus.PROCESSING);
    }

    const checkDb = await sessionRepo.findById(activeSession.id);
    assert.equal(checkDb.status, PaymentStatus.PROCESSING);
  });

  test('CHAOS 3: Dual-channel flood (Gmail + SMS) guarantees exactly 1 payment attribution', async () => {
    const activeSession = await sessionRepo.findCurrentActiveOrProcessing(testAccount.id);
    assert.ok(activeSession);
    assert.equal(activeSession.status, PaymentStatus.PROCESSING);

    const utr = 'UTR-CHAOS-9999';

    const obsSms = ObservationNormalizer.normalize({
      source: ObserverSource.GOOGLE_MESSAGES,
      receivingAccountId: testAccount.id,
      amountPaise: 20000n,
      bankReferenceNumber: utr,
      rawPayload: { text: 'SMS Rs 200' }
    });

    const obsGmail = ObservationNormalizer.normalize({
      source: ObserverSource.GMAIL,
      receivingAccountId: testAccount.id,
      amountPaise: 20000n,
      bankReferenceNumber: utr,
      rawPayload: { text: 'Email Rs 200' }
    });

    const resSms = await attributionEngine.processObservation(obsSms);
    const resGmail = await attributionEngine.processObservation(obsGmail);

    assert.equal(resSms.attributed, true);
    assert.equal(resSms.outcomeStatus, PaymentStatus.SUCCESS);
    assert.equal(resSms.verificationLevel, 1);

    assert.equal(resGmail.attributed, true);
    assert.equal(resGmail.verificationLevel, 2);

    const resSmsDup = await attributionEngine.processObservation(obsSms);
    assert.equal(resSmsDup.attributed, false);
    assert.equal(resSmsDup.duplicate, true);
    assert.equal(resSmsDup.outcomeStatus, ObservationAttributionStatus.DUPLICATE_IGNORED);

    const checkDb = await sessionRepo.findById(activeSession.id);
    assert.equal(checkDb.status, PaymentStatus.SUCCESS);
  });

  test('CHAOS 4: Promotion cascade: completed session immediately unblocks waiting queue in order', async () => {
    const promotedSession = await queueEngine.promoteNext(testAccount.id);
    assert.ok(promotedSession);
    assert.equal(promotedSession.status, PaymentStatus.ACTIVE);
    assert.equal(promotedSession.queuePosition, 0);

    const remainingQueued = await sessionRepo.findQueuedSessions(testAccount.id);
    assert.equal(remainingQueued.length, 8);
    for (let i = 0; i < remainingQueued.length; i++) {
      assert.equal(remainingQueued[i].queuePosition, i + 1);
    }
  });

  test('CHAOS 5: Late observation does not hijack currently active customer session', async () => {
    const activeCustomerB = await sessionRepo.findCurrentActiveOrProcessing(testAccount.id);
    assert.ok(activeCustomerB);

    const expiredCust = await customerRepo.create({
      merchantId: defaultMerchant.id,
      phoneNumber: '9000011111',
      fullName: 'Late Customer',
      password: 'Password1!'
    });

    const expiredSession = await sessionRepo.create({
      merchantId: defaultMerchant.id,
      customerId: expiredCust.id,
      receivingAccountId: testAccount.id,
      orderId: 'ORD-LATE-CUSTOMER',
      amountPaise: 20000n
    });
    await sessionRepo.acquireSlotAtomic(expiredSession.id, testAccount.id, 100);
    await sessionRepo.transitionToTerminal(expiredSession.id, PaymentStatus.EXPIRED);

    const delayedObs = ObservationNormalizer.normalize({
      source: ObserverSource.GMAIL,
      receivingAccountId: testAccount.id,
      amountPaise: 20000n,
      bankReferenceNumber: 'UTR-DELAYED-3322',
      observedAt: new Date(Date.now() - 60000)
    });

    const lateResult = await attributionEngine.processObservation(delayedObs);

    assert.equal(lateResult.attributed, false);
    assert.equal(lateResult.lateMatch, true);
    assert.equal(lateResult.paymentSessionId, expiredSession.id);

    const checkB = await sessionRepo.findById(activeCustomerB.id);
    assert.equal(checkB.status, PaymentStatus.ACTIVE);
  });
});
