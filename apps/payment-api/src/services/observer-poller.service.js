import { getObserverToken } from '@youpi/common';

export class ObserverPollerService {
  constructor(options) {
    if (!options || !options.db || !options.sessionRepo || !options.obsRepo || !options.attributionEngine || !options.eventEmitter) {
      throw new Error('ObserverPollerService requires db, sessionRepo, obsRepo, attributionEngine, and eventEmitter');
    }

    this.db = options.db;
    this.sessionRepo = options.sessionRepo;
    this.obsRepo = options.obsRepo;
    this.attributionEngine = options.attributionEngine;
    this.eventEmitter = options.eventEmitter;

    this.pollIntervalMs = Number(options.pollIntervalMs || process.env.OBSERVER_POLL_INTERVAL_MS || 1500);
    this.minSweepCooldownMs = Number(options.minSweepCooldownMs || process.env.OBSERVER_SWEEP_COOLDOWN_MS || 2000);
    this.smsPort = Number(options.smsPort || process.env.SMS_OBSERVER_PORT || 6002);
    this.gmailPort = Number(options.gmailPort || process.env.GMAIL_OBSERVER_PORT || 6003);
    this.observerToken = options.observerToken || null;

    this._isRunning = false;
    this._isPollingCycle = false;
    this._isIdle = true;
    this._timer = null;

    this._lastSmsSweepTime = 0;
    this._lastGmailSweepTime = 0;
    this._isSmsSweepInFlight = false;
    this._isGmailSweepInFlight = false;

    this._isAttributionInProgress = false;
    this._inFlightObservationHashes = new Set();

    this._boundOnSessionProcessing = this.handleSessionProcessing.bind(this);
    this._boundOnSessionActivated = this.handleSessionActivated.bind(this);
    this._boundOnPaymentTerminal = this.handlePaymentTerminal.bind(this);

    if (options.autoStart !== false) {
      this.start();
    }
  }

  get isRunning() {
    return this._isRunning;
  }

  get isIdle() {
    return this._isIdle;
  }

  get isSmsSweepInFlight() {
    return this._isSmsSweepInFlight;
  }

  get isGmailSweepInFlight() {
    return this._isGmailSweepInFlight;
  }

  get isAttributionInProgress() {
    return this._isAttributionInProgress;
  }

  get lastSmsSweepTime() {
    return this._lastSmsSweepTime;
  }

  get lastGmailSweepTime() {
    return this._lastGmailSweepTime;
  }

  start() {
    if (this._isRunning) return;
    this._isRunning = true;

    this.eventEmitter.on('SESSION.PROCESSING', this._boundOnSessionProcessing);
    this.eventEmitter.on('SESSION.ACTIVATED', this._boundOnSessionActivated);
    this.eventEmitter.on('PAYMENT.SUCCESS', this._boundOnPaymentTerminal);
    this.eventEmitter.on('PAYMENT.FAILED', this._boundOnPaymentTerminal);
    this.eventEmitter.on('PAYMENT.EXPIRED', this._boundOnPaymentTerminal);
    this.eventEmitter.on('PAYMENT.CANCELLED', this._boundOnPaymentTerminal);

    this._timer = setInterval(() => {
      this.pollCycle().catch(() => {});
    }, this.pollIntervalMs);

    if (this._timer.unref) {
      this._timer.unref();
    }

    this.pollCycle().catch(() => {});
  }

  stop() {
    this._isRunning = false;

    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }

    if (this.eventEmitter) {
      this.eventEmitter.removeListener('SESSION.PROCESSING', this._boundOnSessionProcessing);
      this.eventEmitter.removeListener('SESSION.ACTIVATED', this._boundOnSessionActivated);
      this.eventEmitter.removeListener('PAYMENT.SUCCESS', this._boundOnPaymentTerminal);
      this.eventEmitter.removeListener('PAYMENT.FAILED', this._boundOnPaymentTerminal);
      this.eventEmitter.removeListener('PAYMENT.EXPIRED', this._boundOnPaymentTerminal);
      this.eventEmitter.removeListener('PAYMENT.CANCELLED', this._boundOnPaymentTerminal);
    }

    this._inFlightObservationHashes.clear();
    this._isPollingCycle = false;
    this._isAttributionInProgress = false;
    this._isSmsSweepInFlight = false;
    this._isGmailSweepInFlight = false;
    this._isIdle = true;
  }

  destroy() {
    this.stop();
  }

  handleSessionProcessing(data) {
    this.triggerExpeditedSweep(data?.receivingAccountId);
  }

  handleSessionActivated(data) {
    this._isIdle = false;
    this.triggerExpeditedSweep(data?.receivingAccountId);
  }

  handlePaymentTerminal() {
  }

  triggerExpeditedSweep(preferredAccountId = null) {
    if (!this._isRunning || this._isPollingCycle) return;
    this.pollCycle(preferredAccountId).catch(() => {});
  }

  getActiveSessions() {
    try {
      const sixtySecsAgo = new Date(Date.now() - 60000).toISOString();
      return this.db.query(`
        SELECT id, receiving_account_id, amount_paise, status, verification_level
        FROM payment_sessions
        WHERE method = 'UPI' AND (
          (status IN ('ACTIVE', 'PROCESSING') AND COALESCE(verification_level, 0) < 3)
          OR (status = 'SUCCESS' AND COALESCE(verification_level, 0) < 2 AND completed_at >= ?)
        )
      `, [sixtySecsAgo]);
    } catch {
      return [];
    }
  }

  async pollCycle(preferredAccountId = null) {
    if (!this._isRunning || this._isPollingCycle) return;
    this._isPollingCycle = true;

    try {
      const activeSessions = this.getActiveSessions();

      if (activeSessions.length === 0) {
        this._isIdle = true;
        return;
      }

      this._isIdle = false;

      await Promise.allSettled([
        this.sweepSmsObserver(),
        this.sweepGmailObserver()
      ]);

      await this.processPendingAttributions(activeSessions, preferredAccountId);
    } finally {
      this._isPollingCycle = false;
    }
  }

  async sweepSmsObserver() {
    const now = Date.now();
    if (this._isSmsSweepInFlight || (now - this._lastSmsSweepTime < this.minSweepCooldownMs)) {
      return false;
    }

    this._isSmsSweepInFlight = true;
    this._lastSmsSweepTime = now;

    try {
      const token = this.observerToken || getObserverToken();
      const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

      await fetch(`http://localhost:${this.smsPort}/api/sweep`, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(1200)
      });
      return true;
    } catch {
      return false;
    } finally {
      this._isSmsSweepInFlight = false;
    }
  }

  async sweepGmailObserver() {
    const now = Date.now();
    if (this._isGmailSweepInFlight || (now - this._lastGmailSweepTime < this.minSweepCooldownMs)) {
      return false;
    }

    this._isGmailSweepInFlight = true;
    this._lastGmailSweepTime = now;

    try {
      const token = this.observerToken || getObserverToken();
      const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

      await fetch(`http://localhost:${this.gmailPort}/api/sweep`, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(1200)
      });
      return true;
    } catch {
      return false;
    } finally {
      this._isGmailSweepInFlight = false;
    }
  }

  async processPendingAttributions(activeSessions, preferredAccountId = null) {
    if (this._isAttributionInProgress) return;
    this._isAttributionInProgress = true;

    try {
      const rawAccountIds = activeSessions.map(s => s.receiving_account_id).filter(Boolean);
      const accountIds = [...new Set(rawAccountIds)];

      if (preferredAccountId && accountIds.includes(preferredAccountId)) {
        accountIds.sort((a, b) => a === preferredAccountId ? -1 : (b === preferredAccountId ? 1 : 0));
      }

      for (const accountId of accountIds) {
        const unattributed = this.obsRepo.findUnattributed(accountId);
        if (!Array.isArray(unattributed) || unattributed.length === 0) continue;

        for (const obs of unattributed) {
          const hash = obs.fingerprintHash || obs.id;
          if (this._inFlightObservationHashes.has(hash)) continue;

          this._inFlightObservationHashes.add(hash);
          try {
            this.attributionEngine.processObservation({
              source: obs.source,
              receivingAccountId: obs.receivingAccountId,
              amountPaise: obs.amountPaise,
              observedAt: obs.observedAt,
              bankReferenceNumber: obs.bankReferenceNumber,
              senderVpa: obs.senderVpa,
              rawPayload: obs.rawPayload,
              fingerprintHash: obs.fingerprintHash
            });
          } catch {
          } finally {
            this._inFlightObservationHashes.delete(hash);
          }
        }
      }
    } finally {
      this._isAttributionInProgress = false;
    }
  }
}
