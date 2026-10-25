import '../../../../scripts/test-support.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '@youpi/db';
import { PaymentStatus } from '@youpi/common';
import { startServer as startPaymentApi } from '../index.js';

describe('Verification pipeline hardening', () => {
  let api;
  let db;
  const merchantId = '00000000-0000-0000-0000-000000000001';
  const receivingAccountId = '00000000-0000-0000-0000-000000000002';
  let counter = 0;

  before(async () => {
    db = new Database({ inMemory: true });
    api = await startPaymentApi(6297, db);
  });

  after(async () => {
    await api.close();
    db.close();
  });

  function freshSession(amountPaise = 70000n) {
    db.execute("UPDATE payment_sessions SET status = 'EXPIRED' WHERE receiving_account_id = ? AND status IN ('ACTIVE', 'PROCESSING')", [receivingAccountId]);
    db.execute('UPDATE payment_receiving_accounts SET is_slot_busy = 0, current_active_session_id = NULL WHERE id = ?', [receivingAccountId]);
    const session = api.app.context.sessionRepo.create({
      merchantId,
      receivingAccountId,
      orderId: `HARDEN-${++counter}`,
      amountPaise
    });
    api.app.context.queueEngine.enqueueOrActivate(session.id, receivingAccountId);
    return session;
  }

  const run = (extra) => api.app.context.pipeline.process({
    source: 'SMS',
    sender: 'HDFCBK',
    receivingAccountId,
    ...extra
  });

  test('a debit that precedes the credit wording is rejected', () => {
    const session = freshSession();
    const result = run({
      paymentSessionId: session.id,
      rawText: 'Rs 700.00 debited from A/C 1234. Refund will be credited in 48 hours. Ref: 111122223333'
    });
    assert.equal(result.status, 'REJECTED');
    assert.equal(result.failingCondition, 'DEBIT_NOTIFICATION');
  });

  test('a debit that only follows the credit does not block a real credit', () => {
    const session = freshSession();
    const result = run({
      paymentSessionId: session.id,
      rawText: 'A/C 1234 credited with Rs 700.00 via UPI. Ref: 222233334444. Rs 5.00 debited as SMS charge'
    });
    assert.notEqual(result.failingCondition, 'DEBIT_NOTIFICATION');
  });

  test('the reference printed in the message wins over a caller-supplied one', () => {
    const session = freshSession();
    const result = run({
      paymentSessionId: session.id,
      bankReferenceNumber: '999900001111',
      rawText: 'A/C 1234 credited with Rs 700.00 via UPI. UPI Ref No 333344445555'
    });
    assert.equal(result.reference, '333344445555');
  });

  test('a caller-supplied reference is still used when the message has no labelled one', () => {
    const session = freshSession();
    const result = run({
      paymentSessionId: session.id,
      bankReferenceNumber: '444455556666',
      rawText: 'A/C 1234 credited with Rs 700.00 via UPI'
    });
    assert.notEqual(result.failingCondition, 'MISSING_12_DIGIT_REFERENCE');
  });

  test('a closed session addressed by id is not settled', () => {
    const session = freshSession();
    db.execute("UPDATE payment_sessions SET status = 'CANCELLED' WHERE id = ?", [session.id]);
    const result = run({
      paymentSessionId: session.id,
      rawText: 'A/C 1234 credited with Rs 700.00 via UPI. UPI Ref No 555566667777'
    });
    assert.equal(result.status, 'REJECTED');
    assert.equal(result.failingCondition, 'SESSION_NOT_OPEN');
    assert.equal(api.app.context.sessionRepo.findById(session.id).status, PaymentStatus.CANCELLED);
  });

  test('fixture senders are refused for email when running in production mode', () => {
    const previous = process.env.YOUPI_MODE;
    const session = freshSession();
    try {
      process.env.YOUPI_MODE = 'production';
      const result = api.app.context.pipeline.process({
        source: 'GMAIL',
        sender: 'gmail-browser-automator',
        receivingAccountId,
        paymentSessionId: session.id,
        rawText: 'A/C 1234 credited with Rs 700.00 via UPI. UPI Ref No 666677778888'
      });
      assert.equal(result.failingCondition, 'INVALID_EMAIL_DOMAIN');
    } finally {
      process.env.YOUPI_MODE = previous;
    }
  });
});
