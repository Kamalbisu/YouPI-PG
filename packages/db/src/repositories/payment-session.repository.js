import crypto from 'node:crypto';
import { PaymentStatus, PaymentMethod, isValidTransition, TERMINAL_STATES } from '@youpi/common';

export class PaymentSessionRepository {
  constructor(db) {
    this.db = db;
  }

  create(data) {
    const id = data.id || crypto.randomUUID();
    const now = new Date().toISOString();
    const metadata = typeof data.metadata === 'object' ? JSON.stringify(data.metadata) : (data.metadata || '{}');
    const attemptId = data.attemptId || id;

    const sql = `
      INSERT INTO payment_sessions (
        id, merchant_id, customer_id, receiving_account_id, order_id, attempt_id,
        amount_paise, currency, method, status, queue_position,
        return_url, idempotency_key, device_id, verification_level, verification_sources,
        verification_tag, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '[]', 'UNVERIFIED', ?, ?, ?)
    `;

    this.db.execute(sql, [
      id,
      data.merchantId,
      data.customerId || null,
      data.receivingAccountId || null,
      data.orderId,
      attemptId,
      Number(data.amountPaise),
      data.currency || 'INR',
      data.method || PaymentMethod.UPI,
      data.status || PaymentStatus.INITIATED,
      data.queuePosition || 0,
      data.returnUrl || null,
      data.idempotencyKey || null,
      data.deviceId || null,
      metadata,
      now,
      now
    ]);

    return this.findById(id);
  }

  findById(id) {
    const row = this.db.queryOne('SELECT * FROM payment_sessions WHERE id = ?', [id]);
    if (!row) return null;
    return this.mapRow(row);
  }

  findByOrderId(merchantId, orderId) {
    const row = this.db.queryOne(
      'SELECT * FROM payment_sessions WHERE merchant_id = ? AND order_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      [merchantId, orderId]
    );
    if (!row) return null;
    return this.mapRow(row);
  }

  findByCustomerId(customerId) {
    const rows = this.db.query(
      'SELECT * FROM payment_sessions WHERE customer_id = ? ORDER BY created_at DESC',
      [customerId]
    );
    return rows.map(r => this.mapRow(r));
  }

  findByMerchantId(merchantId, limit = 50) {
    const rows = this.db.query(
      'SELECT * FROM payment_sessions WHERE merchant_id = ? ORDER BY created_at DESC LIMIT ?',
      [merchantId, limit]
    );
    return rows.map(r => this.mapRow(r));
  }

  acquireSlotAtomic(sessionId, receivingAccountId, durationMs = 300000) {
    return this.db.transaction(() => {
      const now = new Date();
      const nowIso = now.toISOString();

      let activeRow = this.db.queryOne(`
        SELECT id, status, expires_at, processing_expires_at
        FROM payment_sessions
        WHERE receiving_account_id = ? AND status IN (?, ?)
        LIMIT 1
      `, [receivingAccountId, PaymentStatus.ACTIVE, PaymentStatus.PROCESSING]);

      if (activeRow) {
        const isStale = (activeRow.status === PaymentStatus.ACTIVE && activeRow.expires_at && new Date(activeRow.expires_at) <= now) ||
          (activeRow.status === PaymentStatus.PROCESSING && activeRow.processing_expires_at && new Date(activeRow.processing_expires_at) <= now);
        if (isStale) {
          const terminalStatus = activeRow.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.EXPIRED;
          if (!isValidTransition(activeRow.status, terminalStatus)) {
            throw new Error(`Illegal payment state transition: cannot move from '${activeRow.status}' to '${terminalStatus}'.`);
          }
          this.db.execute(`
            UPDATE payment_sessions
            SET status = ?, completed_at = ?, updated_at = ?
            WHERE id = ?
          `, [terminalStatus, nowIso, nowIso, activeRow.id]);
          activeRow = null;
        }
      }

      if (activeRow && activeRow.id === sessionId) {
        return {
          status: PaymentStatus.ACTIVE,
          queuePosition: 0,
          expiresAt: activeRow.expires_at ? new Date(activeRow.expires_at) : new Date(now.getTime() + durationMs)
        };
      }

      if (!activeRow) {
        const currentStatus = this.findById(sessionId)?.status;
        if (currentStatus && !isValidTransition(currentStatus, PaymentStatus.ACTIVE)) {
          throw new Error(`Illegal payment state transition: cannot move from '${currentStatus}' to 'ACTIVE'.`);
        }

        const expiresAt = new Date(now.getTime() + durationMs).toISOString();

        this.db.execute(`
          UPDATE payment_sessions
          SET status = ?, slot_acquired_at = ?, expires_at = ?, queue_position = 0, updated_at = ?
          WHERE id = ?
        `, [PaymentStatus.ACTIVE, nowIso, expiresAt, nowIso, sessionId]);

        this.db.execute(`
          UPDATE payment_receiving_accounts
          SET is_slot_busy = 1, current_active_session_id = ?, updated_at = ?
          WHERE id = ?
        `, [sessionId, nowIso, receivingAccountId]);

        return {
          status: PaymentStatus.ACTIVE,
          queuePosition: 0,
          expiresAt: new Date(expiresAt)
        };
      } else {
        const existingSession = this.findById(sessionId);
        let queuePosition = existingSession?.queuePosition;
        if (!queuePosition || queuePosition <= 0) {
          const posRow = this.db.queryOne(`
            SELECT COALESCE(MAX(queue_position), 0) + 1 AS next_pos
            FROM payment_sessions
            WHERE receiving_account_id = ? AND status = ?
          `, [receivingAccountId, PaymentStatus.QUEUED]);

          queuePosition = posRow ? posRow.next_pos : 1;
        }

        if (existingSession && !isValidTransition(existingSession.status, PaymentStatus.QUEUED)) {
          throw new Error(`Illegal payment state transition: cannot move from '${existingSession.status}' to 'QUEUED'.`);
        }

        this.db.execute(`
          UPDATE payment_sessions
          SET status = ?, queue_position = ?, updated_at = ?
          WHERE id = ?
        `, [PaymentStatus.QUEUED, queuePosition, nowIso, sessionId]);

        return {
          status: PaymentStatus.QUEUED,
          queuePosition,
          expiresAt: null
        };
      }
    });
  }

  transitionToProcessing(sessionId, durationMs = 30000) {
    return this.db.transaction(() => {
      const session = this.findById(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);

      if (session.status === PaymentStatus.PROCESSING) {
        return session;
      }

      if (session.status !== PaymentStatus.ACTIVE) {
        throw new Error(`Cannot transition to PROCESSING from status: ${session.status}`);
      }

      const now = new Date();
      const nowIso = now.toISOString();
      const processingExpiresAt = new Date(now.getTime() + durationMs).toISOString();

      this.db.execute(`
        UPDATE payment_sessions
        SET status = ?, processing_started_at = ?, processing_expires_at = ?, updated_at = ?
        WHERE id = ? AND status = ?
      `, [PaymentStatus.PROCESSING, nowIso, processingExpiresAt, nowIso, sessionId, PaymentStatus.ACTIVE]);

      return this.findById(sessionId);
    });
  }

  transitionToTerminal(sessionId, targetStatus, options = {}) {
    return this.db.transaction(() => {
      const session = this.findById(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);

      const terminalStates = [
        PaymentStatus.SUCCESS,
        PaymentStatus.FAILED,
        PaymentStatus.EXPIRED,
        PaymentStatus.CANCELLED
      ];

      if (terminalStates.includes(session.status)) {
        return session;
      }

      if (!TERMINAL_STATES.includes(targetStatus)) {
        throw new Error(`Not a terminal target status: ${targetStatus}`);
      }
      if (!isValidTransition(session.status, targetStatus)) {
        throw new Error(`Illegal payment state transition: cannot move from '${session.status}' to '${targetStatus}'.`);
      }

      const now = new Date().toISOString();
      const attributedObsId = options.attributedObservationId || session.attributedObservationId || null;

      let metadata = session.metadata || {};
      if (typeof metadata === 'string') {
        try { metadata = JSON.parse(metadata); } catch { metadata = {}; }
      }
      if (options.reason) {
        metadata = { ...metadata, cancelledReason: options.reason };
      }
      if (options.replacedByDeviceId) {
        metadata = { ...metadata, replacedByDeviceId: options.replacedByDeviceId };
      }
      if (options.replacedBySessionId) {
        metadata = { ...metadata, replacedBySessionId: options.replacedBySessionId };
      }

      this.db.execute(`
        UPDATE payment_sessions
        SET status = ?, completed_at = ?, attributed_observation_id = ?, metadata = ?, updated_at = ?
        WHERE id = ?
      `, [targetStatus, now, attributedObsId, JSON.stringify(metadata), now, sessionId]);

      if (session.receivingAccountId) {
        this.db.execute(`
          UPDATE payment_receiving_accounts
          SET is_slot_busy = 0, current_active_session_id = NULL, updated_at = ?
          WHERE id = ? AND (current_active_session_id = ? OR current_active_session_id IS NULL)
        `, [now, session.receivingAccountId, sessionId]);
      }

      return this.findById(sessionId);
    });
  }

  findCurrentActiveOrProcessing(receivingAccountId) {
    const row = this.db.queryOne(`
      SELECT * FROM payment_sessions
      WHERE receiving_account_id = ? AND status IN (?, ?)
      LIMIT 1
    `, [receivingAccountId, PaymentStatus.ACTIVE, PaymentStatus.PROCESSING]);

    if (!row) return null;
    const now = new Date();
    const isStale = (row.status === PaymentStatus.ACTIVE && row.expires_at && new Date(row.expires_at) <= now) ||
      (row.status === PaymentStatus.PROCESSING && row.processing_expires_at && new Date(row.processing_expires_at) <= now);
    if (isStale) {
      const terminalStatus = row.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.EXPIRED;
      this.transitionToTerminal(row.id, terminalStatus);
      return null;
    }
    return this.mapRow(row);
  }

  findCurrentActiveOrProcessingForMerchant(merchantId) {
    if (!merchantId) return null;
    const row = this.db.queryOne(`
      SELECT * FROM payment_sessions
      WHERE merchant_id = ? AND status IN (?, ?)
      ORDER BY created_at DESC
      LIMIT 1
    `, [merchantId, PaymentStatus.ACTIVE, PaymentStatus.PROCESSING]);

    if (!row) return null;
    const now = new Date();
    const isStale = (row.status === PaymentStatus.ACTIVE && row.expires_at && new Date(row.expires_at) <= now) ||
      (row.status === PaymentStatus.PROCESSING && row.processing_expires_at && new Date(row.processing_expires_at) <= now);
    if (isStale) {
      const terminalStatus = row.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.EXPIRED;
      this.transitionToTerminal(row.id, terminalStatus);
      return null;
    }
    return this.mapRow(row);
  }

  findActiveForCustomer(customerId, excludeSessionId = null) {
    if (!customerId) return null;
    let query = `
      SELECT * FROM payment_sessions
      WHERE customer_id = ? AND status IN (?, ?, ?)
    `;
    const params = [customerId, PaymentStatus.ACTIVE, PaymentStatus.PROCESSING, PaymentStatus.QUEUED];
    if (excludeSessionId) {
      query += ` AND id != ? `;
      params.push(excludeSessionId);
    }
    query += ` ORDER BY created_at DESC LIMIT 1 `;
    const row = this.db.queryOne(query, params);

    if (!row) return null;
    const now = new Date();
    const isStale = (row.status === PaymentStatus.ACTIVE && row.expires_at && new Date(row.expires_at) <= now) ||
      (row.status === PaymentStatus.PROCESSING && row.processing_expires_at && new Date(row.processing_expires_at) <= now);
    if (isStale) {
      const terminalStatus = row.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.EXPIRED;
      this.transitionToTerminal(row.id, terminalStatus);
      return null;
    }
    return this.mapRow(row);
  }

  findActiveForDevice(deviceId, excludeSessionId = null) {
    if (!deviceId) return null;
    let query = `
      SELECT * FROM payment_sessions
      WHERE device_id = ? AND status IN (?, ?, ?)
    `;
    const params = [deviceId, PaymentStatus.ACTIVE, PaymentStatus.PROCESSING, PaymentStatus.QUEUED];
    if (excludeSessionId) {
      query += ` AND id != ? `;
      params.push(excludeSessionId);
    }
    query += ` ORDER BY created_at DESC LIMIT 1 `;
    const row = this.db.queryOne(query, params);

    if (!row) return null;
    const now = new Date();
    const isStale = (row.status === PaymentStatus.ACTIVE && row.expires_at && new Date(row.expires_at) <= now) ||
      (row.status === PaymentStatus.PROCESSING && row.processing_expires_at && new Date(row.processing_expires_at) <= now);
    if (isStale) {
      const terminalStatus = row.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.EXPIRED;
      this.transitionToTerminal(row.id, terminalStatus);
      return null;
    }
    return this.mapRow(row);
  }

  findConflictingActiveSession({ customerId = null, deviceId = null, excludeSessionId = null }) {
    if (!customerId && !deviceId) return null;
    let query = `
      SELECT * FROM payment_sessions
      WHERE status IN (?, ?, ?)
    `;
    const params = [PaymentStatus.ACTIVE, PaymentStatus.PROCESSING, PaymentStatus.QUEUED];
    if (excludeSessionId) {
      query += ` AND id != ? `;
      params.push(excludeSessionId);
    }
    if (customerId && deviceId) {
      query += ` AND (customer_id = ? OR device_id = ?) `;
      params.push(customerId, deviceId);
    } else if (customerId) {
      query += ` AND customer_id = ? `;
      params.push(customerId);
    } else {
      query += ` AND device_id = ? `;
      params.push(deviceId);
    }
    query += ` ORDER BY created_at DESC LIMIT 1 `;
    const row = this.db.queryOne(query, params);

    if (!row) return null;
    const now = new Date();
    const isStale = (row.status === PaymentStatus.ACTIVE && row.expires_at && new Date(row.expires_at) <= now) ||
      (row.status === PaymentStatus.PROCESSING && row.processing_expires_at && new Date(row.processing_expires_at) <= now);
    if (isStale) {
      const terminalStatus = row.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.EXPIRED;
      this.transitionToTerminal(row.id, terminalStatus);
      return null;
    }
    return this.mapRow(row);
  }

  findAllActiveOrPendingForCustomer(customerId) {
    if (!customerId) return [];
    const rows = this.db.query(`
      SELECT * FROM payment_sessions
      WHERE customer_id = ? AND status IN (?, ?, ?, ?)
      ORDER BY created_at DESC
    `, [customerId, PaymentStatus.ACTIVE, PaymentStatus.PROCESSING, PaymentStatus.QUEUED, PaymentStatus.INITIATED]);
    return rows.map(r => this.mapRow(r));
  }

  findQueuedSessions(receivingAccountId) {
    const rows = this.db.query(`
      SELECT * FROM payment_sessions
      WHERE receiving_account_id = ? AND status = ?
      ORDER BY queue_position ASC, created_at ASC
    `, [receivingAccountId, PaymentStatus.QUEUED]);

    return rows.map(r => this.mapRow(r));
  }

  getNextQueuedSession(receivingAccountId) {
    const row = this.db.queryOne(`
      SELECT * FROM payment_sessions
      WHERE receiving_account_id = ? AND status = ?
      ORDER BY queue_position ASC, created_at ASC
      LIMIT 1
    `, [receivingAccountId, PaymentStatus.QUEUED]);

    if (!row) return null;
    return this.mapRow(row);
  }

  reindexQueue(receivingAccountId) {
    const queued = this.findQueuedSessions(receivingAccountId);
    let pos = 1;
    for (const session of queued) {
      this.db.execute(`
        UPDATE payment_sessions SET queue_position = ?, updated_at = ?
        WHERE id = ?
      `, [pos++, new Date().toISOString(), session.id]);
    }
  }

  findRecentlyExpiredOrFailed(receivingAccountId, sinceDate) {
    const rows = this.db.query(`
      SELECT * FROM payment_sessions
      WHERE receiving_account_id = ?
        AND status IN (?, ?, ?)
        AND updated_at >= ?
      ORDER BY updated_at DESC
      LIMIT 20
    `, [receivingAccountId, PaymentStatus.EXPIRED, PaymentStatus.FAILED, PaymentStatus.CANCELLED, sinceDate.toISOString()]);

    return rows.map(r => this.mapRow(r));
  }

  recordVerificationSource(sessionId, source, observationId, options = {}) {
    return this.db.transaction(() => {
      const session = this.findById(sessionId);
      if (!session) throw new Error(`Payment session not found: ${sessionId}`);

      const DEAD_STATES = [
        PaymentStatus.FAILED,
        PaymentStatus.EXPIRED,
        PaymentStatus.CANCELLED
      ];
      if (DEAD_STATES.includes(session.status)) {
        return {
          session,
          level: session.verificationLevel || 0,
          sources: session.verificationSources || [],
          tag: session.verificationTag || 'UNVERIFIED',
          isFirstSuccess: false
        };
      }

      const sourcesSet = new Set(session.verificationSources || []);
      sourcesSet.add(source);
      const sources = Array.from(sourcesSet);

      const level = Math.min(2, sources.length);
      const sourceLabels = sources.map(s => {
        if (s === 'GOOGLE_MESSAGES') return 'SMS';
        if (s === 'GMAIL') return 'Gmail';
        return s;
      });

      let tag = `Single Verification (${sourceLabels.join(', ')})`;
      if (level >= 2) {
        tag = `Dual Verification (${sourceLabels.join(' + ')})`;
      }

      const shouldFinalize = options.finalizeSuccess !== false;
      const wantsSuccess = shouldFinalize && level >= 1;
      if (wantsSuccess && session.status !== PaymentStatus.SUCCESS && !isValidTransition(session.status, PaymentStatus.SUCCESS)) {
        throw new Error(`Illegal payment state transition: cannot move from '${session.status}' to 'SUCCESS'.`);
      }
      const isFirstSuccess = wantsSuccess && session.status !== PaymentStatus.SUCCESS;
      const targetStatus = wantsSuccess ? PaymentStatus.SUCCESS : session.status;
      const now = new Date().toISOString();

      this.db.execute(`
        UPDATE payment_sessions
        SET status = ?,
            verification_level = ?,
            verification_sources = ?,
            verification_tag = ?,
            attributed_observation_id = COALESCE(attributed_observation_id, ?),
            completed_at = COALESCE(completed_at, ?),
            updated_at = ?
        WHERE id = ?
      `, [
        targetStatus,
        level,
        JSON.stringify(sources),
        tag,
        observationId,
        targetStatus === PaymentStatus.SUCCESS ? now : null,
        now,
        sessionId
      ]);

      if (targetStatus === PaymentStatus.SUCCESS && session.receivingAccountId) {
        this.db.execute(`
          UPDATE payment_receiving_accounts
          SET is_slot_busy = 0, current_active_session_id = NULL, updated_at = ?
          WHERE id = ? AND current_active_session_id = ?
        `, [now, session.receivingAccountId, sessionId]);
      }

      const updated = this.findById(sessionId);
      return {
        session: updated,
        level,
        sources,
        tag,
        isFirstSuccess
      };
    });
  }

  bindDevice(sessionId, deviceId) {
    const now = new Date().toISOString();
    this.db.execute(
      'UPDATE payment_sessions SET device_id = ?, updated_at = ? WHERE id = ?',
      [deviceId, now, sessionId]
    );
    return this.findById(sessionId);
  }

  mapRow(row) {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      customerId: row.customer_id,
      receivingAccountId: row.receiving_account_id,
      orderId: row.order_id,
      attemptId: row.attempt_id || row.id,
      amountPaise: BigInt(row.amount_paise),
      currency: row.currency,
      method: row.method,
      status: row.status,
      queuePosition: row.queue_position,
      slotAcquiredAt: row.slot_acquired_at ? new Date(row.slot_acquired_at) : null,
      expiresAt: row.expires_at ? new Date(row.expires_at) : null,
      processingStartedAt: row.processing_started_at ? new Date(row.processing_started_at) : null,
      processingExpiresAt: row.processing_expires_at ? new Date(row.processing_expires_at) : null,
      completedAt: row.completed_at ? new Date(row.completed_at) : null,
      returnUrl: row.return_url,
      attributedObservationId: row.attributed_observation_id,
      idempotencyKey: row.idempotency_key,
      deviceId: row.device_id || null,
      verificationLevel: row.verification_level !== undefined && row.verification_level !== null ? Number(row.verification_level) : 0,
      verificationSources: JSON.parse(row.verification_sources || '[]'),
      verificationTag: row.verification_tag || 'UNVERIFIED',
      metadata: JSON.parse(row.metadata || '{}'),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }
}

