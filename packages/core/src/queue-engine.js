import { PaymentStatus } from '@youpi/common';

export class QueueEngine {
  constructor(options) {
    this.activeDurationMs = options.activeDurationMs || 300000;
    this.processingDurationMs = options.processingDurationMs || 30000;
    this.sessionRepo = options.sessionRepo;
    this.accountRepo = options.accountRepo;
    this.eventEmitter = options.eventEmitter || { emit: () => {} };
    this.auditRepo = options.auditRepo;
  }

  enqueueOrActivate(sessionId, receivingAccountId, activeDurationMs = this.activeDurationMs) {
    const result = this.sessionRepo.acquireSlotAtomic(sessionId, receivingAccountId, activeDurationMs);

    if (result.status === PaymentStatus.ACTIVE) {
      this.eventEmitter.emit('SESSION.ACTIVATED', {
        sessionId,
        receivingAccountId,
        expiresAt: result.expiresAt
      });

      if (this.auditRepo) {
        this.auditRepo.log({
          entityType: 'PAYMENT_SESSION',
          entityId: sessionId,
          action: 'PAYMENT_SLOT_ACTIVATED',
          actorType: 'SYSTEM',
          details: { receivingAccountId, expiresAt: result.expiresAt?.toISOString() }
        });
      }
    } else {
      this.eventEmitter.emit('SESSION.QUEUED', {
        sessionId,
        receivingAccountId,
        queuePosition: result.queuePosition
      });

      if (this.auditRepo) {
        this.auditRepo.log({
          entityType: 'PAYMENT_SESSION',
          entityId: sessionId,
          action: 'PAYMENT_ENQUEUED',
          actorType: 'SYSTEM',
          details: { receivingAccountId, queuePosition: result.queuePosition }
        });
      }
    }

    return result;
  }

  promoteNext(receivingAccountId, activeDurationMs = this.activeDurationMs) {
    const active = this.sessionRepo.findCurrentActiveOrProcessing(receivingAccountId);
    if (active) {
      return null;
    }

    const nextQueued = this.sessionRepo.getNextQueuedSession(receivingAccountId);
    if (!nextQueued) {
      return null;
    }

    const res = this.sessionRepo.acquireSlotAtomic(nextQueued.id, receivingAccountId, activeDurationMs);
    if (res.status === PaymentStatus.ACTIVE) {
      this.sessionRepo.reindexQueue(receivingAccountId);

      const activatedSession = this.sessionRepo.findById(nextQueued.id);

      this.eventEmitter.emit('SESSION.ACTIVATED', {
        sessionId: nextQueued.id,
        receivingAccountId,
        expiresAt: activatedSession.expiresAt
      });

      this.eventEmitter.emit('QUEUE.PROMOTED', {
        receivingAccountId,
        promotedSessionId: nextQueued.id
      });

      if (this.auditRepo) {
        this.auditRepo.log({
          merchantId: activatedSession.merchantId,
          entityType: 'PAYMENT_SESSION',
          entityId: nextQueued.id,
          action: 'QUEUE_PROMOTION_TO_ACTIVE',
          actorType: 'SYSTEM',
          details: { receivingAccountId, expiresAt: activatedSession.expiresAt?.toISOString() }
        });
      }

      return activatedSession;
    }

    return null;
  }

  calculateEstimatedWaitSeconds(receivingAccountId, queuePosition) {
    if (queuePosition <= 0) return 0;

    let currentSlotRemaining = 0;
    const currentActive = this.sessionRepo.findCurrentActiveOrProcessing(receivingAccountId);

    if (currentActive) {
      const now = Date.now();
      if (currentActive.status === PaymentStatus.PROCESSING && currentActive.processingExpiresAt) {
        currentSlotRemaining = Math.max(0, Math.ceil((currentActive.processingExpiresAt.getTime() - now) / 1000));
      } else if (currentActive.status === PaymentStatus.ACTIVE && currentActive.expiresAt) {
        currentSlotRemaining = Math.max(0, Math.ceil((currentActive.expiresAt.getTime() - now) / 1000));
      }
    }

    const CYCLE_DURATION_SECONDS = Math.round((this.activeDurationMs + this.processingDurationMs) / 1000);
    const precedingQueuedWait = (queuePosition - 1) * CYCLE_DURATION_SECONDS;

    return currentSlotRemaining + precedingQueuedWait;
  }
}
