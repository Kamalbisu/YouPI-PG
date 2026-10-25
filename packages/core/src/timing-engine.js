import { PaymentStatus } from '@youpi/common';

export class TimingEngine {
  constructor(options) {
    this.sessionRepo = options.sessionRepo;
    this.queueEngine = options.queueEngine;
    this.eventEmitter = options.eventEmitter || { emit: () => {} };
    this.auditRepo = options.auditRepo;
    this.activeDurationMs = options.activeDurationMs || 300000;
    this.processingDurationMs = options.processingDurationMs || 30000;

    this.activeTimers = new Map();
    this.processingTimers = new Map();
  }

  startActiveTimer(sessionId, expiresAt) {
    this.clearTimers(sessionId);

    const delayMs = Math.max(0, expiresAt.getTime() - Date.now());

    const timer = setTimeout(() => {
      this.handleActiveTimerExpiration(sessionId).catch((err) => console.error("[timing] active-timer expiry failed:", err?.message || err));
    }, delayMs);

    if (timer.unref) timer.unref();

    this.activeTimers.set(sessionId, timer);
  }

  async handleActiveTimerExpiration(sessionId) {
    this.activeTimers.delete(sessionId);

    const session = await this.sessionRepo.findById(sessionId);
    if (!session) return;

    if (session.status !== PaymentStatus.ACTIVE) {
      return;
    }

    await this.sessionRepo.transitionToTerminal(sessionId, PaymentStatus.EXPIRED);

    if (this.auditRepo) {
      await this.auditRepo.log({
        merchantId: session.merchantId,
        entityType: 'PAYMENT_SESSION',
        entityId: sessionId,
        action: 'PAYMENT_EXPIRED_TIMEOUT',
        actorType: 'SYSTEM',
        details: { reason: '5-minute payment window elapsed without customer clicking Payment Done' }
      });
    }

    this.eventEmitter.emit('SESSION.EXPIRED', { sessionId, receivingAccountId: session.receivingAccountId });
    this.eventEmitter.emit('PAYMENT.EXPIRED', {
      paymentId: sessionId,
      orderId: session.orderId,
      merchantId: session.merchantId,
      amountPaise: session.amountPaise
    });

    if (session.receivingAccountId) {
      await this.queueEngine.promoteNext(session.receivingAccountId, this.activeDurationMs);
    }
  }

  cancelActiveTimer(sessionId) {
    const activeTimer = this.activeTimers.get(sessionId);
    if (activeTimer) {
      clearTimeout(activeTimer);
      this.activeTimers.delete(sessionId);
    }
  }

  async handlePaymentDone(sessionId) {
    const activeTimer = this.activeTimers.get(sessionId);
    if (activeTimer) {
      clearTimeout(activeTimer);
      this.activeTimers.delete(sessionId);
    }

    const session = await this.sessionRepo.transitionToProcessing(sessionId, this.processingDurationMs);

    if (this.auditRepo) {
      await this.auditRepo.log({
        merchantId: session.merchantId,
        entityType: 'PAYMENT_SESSION',
        entityId: sessionId,
        action: 'CUSTOMER_CLICKED_PAYMENT_DONE',
        actorType: 'CUSTOMER',
        details: { processingExpiresAt: session.processingExpiresAt?.toISOString() }
      });
    }

    this.eventEmitter.emit('SESSION.PROCESSING', {
      sessionId,
      receivingAccountId: session.receivingAccountId,
      processingExpiresAt: session.processingExpiresAt
    });

    const delayMs = Math.max(0, session.processingExpiresAt.getTime() - Date.now());

    const procTimer = setTimeout(() => {
      this.handleProcessingTimerExpiration(sessionId).catch((err) => console.error("[timing] processing-timer expiry failed:", err?.message || err));
    }, delayMs);

    if (procTimer.unref) procTimer.unref();
    this.processingTimers.set(sessionId, procTimer);

    return session;
  }

  async handleProcessingTimerExpiration(sessionId) {
    this.processingTimers.delete(sessionId);

    const session = await this.sessionRepo.findById(sessionId);
    if (!session) return;

    if (session.status !== PaymentStatus.PROCESSING) {
      return;
    }

    await this.sessionRepo.transitionToTerminal(sessionId, PaymentStatus.FAILED);

    if (this.auditRepo) {
      await this.auditRepo.log({
        merchantId: session.merchantId,
        entityType: 'PAYMENT_SESSION',
        entityId: sessionId,
        action: 'PAYMENT_FAILED_NO_OBSERVATION',
        actorType: 'SYSTEM',
        details: { reason: '30-second verification window elapsed with no matching observation' }
      });
    }

    this.eventEmitter.emit('SESSION.FAILED', { sessionId, receivingAccountId: session.receivingAccountId });
    this.eventEmitter.emit('PAYMENT.FAILED', {
      paymentId: sessionId,
      orderId: session.orderId,
      merchantId: session.merchantId,
      amountPaise: session.amountPaise
    });

    if (session.receivingAccountId) {
      await this.queueEngine.promoteNext(session.receivingAccountId, this.activeDurationMs);
    }
  }

  async handleCancel(sessionId) {
    const session = await this.sessionRepo.findById(sessionId);
    if (!session) return null;

    if ([PaymentStatus.PROCESSING, PaymentStatus.SUCCESS, PaymentStatus.FAILED, PaymentStatus.EXPIRED, PaymentStatus.CANCELLED, PaymentStatus.SUSPICIOUS].includes(session.status)) {
      return session;
    }

    this.clearTimers(sessionId);

    const updated = await this.sessionRepo.transitionToTerminal(sessionId, PaymentStatus.CANCELLED);

    if (this.auditRepo) {
      await this.auditRepo.log({
        merchantId: session.merchantId,
        entityType: 'PAYMENT_SESSION',
        entityId: sessionId,
        action: 'PAYMENT_CANCELLED_BY_USER',
        actorType: 'CUSTOMER',
        details: { previousStatus: session.status }
      });
    }

    this.eventEmitter.emit('SESSION.CANCELLED', { sessionId, receivingAccountId: session.receivingAccountId });
    this.eventEmitter.emit('PAYMENT.CANCELLED', {
      paymentId: sessionId,
      orderId: session.orderId,
      merchantId: session.merchantId,
      amountPaise: session.amountPaise
    });

    if (session.receivingAccountId) {
      await this.queueEngine.promoteNext(session.receivingAccountId, this.activeDurationMs);
    }

    return updated;
  }

  clearTimers(sessionId) {
    const act = this.activeTimers.get(sessionId);
    if (act) {
      clearTimeout(act);
      this.activeTimers.delete(sessionId);
    }

    const prc = this.processingTimers.get(sessionId);
    if (prc) {
      clearTimeout(prc);
      this.processingTimers.delete(sessionId);
    }
  }

  destroy() {
    for (const timer of this.activeTimers.values()) {
      clearTimeout(timer);
    }
    for (const timer of this.processingTimers.values()) {
      clearTimeout(timer);
    }
    this.activeTimers.clear();
    this.processingTimers.clear();
  }
}
