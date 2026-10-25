import { PaymentStatus } from '@youpi/common';

export class RecoveryEngine {
  constructor(options) {
    this.db = options.db;
    this.sessionRepo = options.sessionRepo;
    this.accountRepo = options.accountRepo;
    this.queueEngine = options.queueEngine;
    this.timingEngine = options.timingEngine;
    this.auditRepo = options.auditRepo;
    this.eventEmitter = options.eventEmitter;
  }

  async recover() {
    let expiredCount = 0;
    let failedCount = 0;
    let rescheduledCount = 0;
    let promotedCount = 0;

    const now = new Date();
    const nowIso = now.toISOString();

    const overdueProcessing = await this.db.query(`
      SELECT id, merchant_id, order_id, receiving_account_id, verification_level, attributed_observation_id FROM payment_sessions
      WHERE status = ? AND processing_expires_at < ?
    `, [PaymentStatus.PROCESSING, nowIso]);

    for (const row of overdueProcessing) {
      if (row.verification_level >= 1 || row.attributed_observation_id) {
        await this.sessionRepo.transitionToTerminal(row.id, PaymentStatus.SUCCESS);
        if (this.auditRepo) {
          await this.auditRepo.log({
            entityType: 'PAYMENT_SESSION',
            entityId: row.id,
            action: 'CRASH_RECOVERY_ATTRIBUTED_SUCCESS',
            actorType: 'SYSTEM'
          });
        }
        if (this.eventEmitter) {
          this.eventEmitter.emit('PAYMENT.SUCCESS', {
            paymentId: row.id,
            orderId: row.order_id,
            merchantId: row.merchant_id
          });
        }
      } else {
        await this.sessionRepo.transitionToTerminal(row.id, PaymentStatus.FAILED);
        failedCount++;
        if (this.auditRepo) {
          await this.auditRepo.log({
            entityType: 'PAYMENT_SESSION',
            entityId: row.id,
            action: 'CRASH_RECOVERY_EXPIRED_PROCESSING',
            actorType: 'SYSTEM'
          });
        }
        if (this.eventEmitter) {
          this.eventEmitter.emit('PAYMENT.FAILED', {
            paymentId: row.id,
            orderId: row.order_id,
            merchantId: row.merchant_id
          });
        }
      }
    }

    const overdueActive = await this.db.query(`
      SELECT id, merchant_id, order_id, receiving_account_id FROM payment_sessions
      WHERE status = ? AND expires_at < ?
    `, [PaymentStatus.ACTIVE, nowIso]);

    for (const row of overdueActive) {
      await this.sessionRepo.transitionToTerminal(row.id, PaymentStatus.EXPIRED);
      expiredCount++;
      if (this.auditRepo) {
        await this.auditRepo.log({
          entityType: 'PAYMENT_SESSION',
          entityId: row.id,
          action: 'CRASH_RECOVERY_EXPIRED_ACTIVE',
          actorType: 'SYSTEM'
        });
      }
      if (this.eventEmitter) {
        this.eventEmitter.emit('PAYMENT.EXPIRED', {
          paymentId: row.id,
          orderId: row.order_id,
          merchantId: row.merchant_id
        });
      }
    }

    const ongoingActive = await this.db.query(`
      SELECT id, expires_at FROM payment_sessions
      WHERE status = ? AND expires_at >= ?
    `, [PaymentStatus.ACTIVE, nowIso]);

    for (const row of ongoingActive) {
      this.timingEngine.startActiveTimer(row.id, new Date(row.expires_at));
      rescheduledCount++;
    }

    const ongoingProcessing = await this.db.query(`
      SELECT id, processing_expires_at FROM payment_sessions
      WHERE status = ? AND processing_expires_at >= ?
    `, [PaymentStatus.PROCESSING, nowIso]);

    for (const row of ongoingProcessing) {
      const remainingMs = Math.max(0, new Date(row.processing_expires_at).getTime() - Date.now());
      const procTimer = setTimeout(() => {
        Promise.resolve(this.timingEngine.handleProcessingTimerExpiration(row.id)).catch((err) => console.error("[recovery] processing-timer expiry failed:", err?.message || err));
      }, remainingMs);
      if (procTimer.unref) procTimer.unref();
      this.timingEngine.processingTimers.set(row.id, procTimer);
      rescheduledCount++;
    }

    const accounts = await this.db.query(`SELECT id FROM payment_receiving_accounts WHERE is_active = true`);
    for (const acc of accounts) {
      const promoted = await this.queueEngine.promoteNext(acc.id);
      if (promoted) {
        promotedCount++;
        this.timingEngine.startActiveTimer(promoted.id, promoted.expiresAt);
      }
    }

    return {
      expiredCount,
      failedCount,
      rescheduledCount,
      promotedCount
    };
  }
}
