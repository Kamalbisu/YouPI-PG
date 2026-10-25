import crypto from 'node:crypto';
import { hashPassword, verifyPassword, normalizeEmail, normalizeMobile, isValidEmail, isValidMobile, isValidPassword, safeEqual, encryptAtRest, decryptAtRest } from '@youpi/common';

const OTP_MAX_ATTEMPTS = 5;

export class CustomerRepository {
  constructor(db) {
    this.db = db;
  }

  async create(data) {
    const id = data.id || crypto.randomUUID();
    const name = String(data.name || data.fullName || '').trim();
    const mobileNumber = normalizeMobile(data.mobileNumber || data.phoneNumber);
    let email = normalizeEmail(data.email);
    const status = data.status || 'ACTIVE';

    if (!name) {
      throw new Error('Customer name is required.');
    }
    if (!mobileNumber || !isValidMobile(mobileNumber)) {
      throw new Error('Invalid mobile number format (must be a valid 10-digit number).');
    }
    if (!email) {
      email = `${mobileNumber}@customer.youpi.local`;
    } else if (!isValidEmail(email)) {
      throw new Error('Invalid email address format.');
    }

    let passwordHash = data.passwordHash || null;
    if (!passwordHash && data.password) {
      if (!isValidPassword(data.password)) {
        throw new Error('Password must be at least 6 characters long.');
      }
      passwordHash = hashPassword(data.password);
    }

    const otpCode = data.otpCode || null;
    const otpExpiresAt = data.otpExpiresAt || null;
    const isPhoneVerified = Boolean(data.isPhoneVerified);
    const now = new Date().toISOString();

    const sql = `
      INSERT INTO customers (id, name, email, mobile_number, password_hash, otp_code, otp_expires_at, is_phone_verified, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await this.db.execute(sql, [
      id,
      name,
      email,
      mobileNumber,
      passwordHash,
      otpCode,
      otpExpiresAt,
      isPhoneVerified,
      status,
      now,
      now
    ]);

    return await this.findById(id);
  }

  async findById(id) {
    if (!id) return null;
    const row = await this.db.queryOne('SELECT * FROM customers WHERE id = ?', [id]);
    if (!row) return null;
    return this.mapRow(row);
  }

  async findByEmail(email) {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    const row = await this.db.queryOne('SELECT * FROM customers WHERE email = ?', [normalized]);
    if (!row) return null;
    return this.mapRow(row);
  }

  async findByMobile(mobileNumber) {
    const normalized = normalizeMobile(mobileNumber);
    if (!normalized) return null;
    const clean10 = normalized.slice(-10);
    const row = await this.db.queryOne(
      'SELECT * FROM customers WHERE mobile_number = ? OR mobile_number = ? OR mobile_number = ? OR mobile_number LIKE ?',
      [normalized, clean10, '+91' + clean10, '%' + clean10]
    );
    if (!row) return null;
    return this.mapRow(row);
  }

  async findByPhone(arg1, arg2) {
    const phone = arg2 || arg1;
    return await this.findByMobile(phone);
  }

  async findByIdentifier(identifier) {
    if (!identifier) return null;
    const trimmed = String(identifier).trim();
    if (trimmed.includes('@')) {
      return await this.findByEmail(trimmed);
    }
    const asMobile = await this.findByMobile(trimmed);
    if (asMobile) return asMobile;
    return await this.findByEmail(trimmed);
  }

  async verifyCredentials(arg1, arg2, arg3) {
    let identifier = arg1;
    let password = arg2;
    if (arg3 !== undefined) {
      identifier = arg2;
      password = arg3;
    }

    if (!identifier || !password) return null;

    const customer = await this.findByIdentifier(identifier);
    if (!customer) return null;

    if (customer.status !== 'ACTIVE') return null;

    const isValid = verifyPassword(password, customer.passwordHash);
    if (!isValid) return null;

    const now = new Date().toISOString();
    try {
      await this.db.execute('UPDATE customers SET last_login_at = ?, updated_at = ? WHERE id = ?', [now, now, customer.id]);
    } catch {}

    const { passwordHash, ...safeCustomer } = customer;
    safeCustomer.lastLoginAt = new Date(now);
    return safeCustomer;
  }

  async setOtp(mobileNumber, otpCode, expiresAt) {
    const normalized = normalizeMobile(mobileNumber);
    if (!normalized) return null;
    const now = new Date().toISOString();
    await this.db.execute(
      `UPDATE customers SET otp_code = ?, otp_expires_at = ?,
         otp_attempts = CASE WHEN otp_code IS NOT NULL AND otp_expires_at IS NOT NULL AND otp_expires_at > ? THEN otp_attempts ELSE 0 END,
         updated_at = ? WHERE mobile_number = ?`,
      [encryptAtRest(otpCode), expiresAt, now, now, normalized]
    );
    return await this.findByMobile(normalized);
  }

  async verifyOtp(mobileNumber, otpCode) {
    const normalized = normalizeMobile(mobileNumber);
    if (!normalized || !otpCode) return null;
    const customer = await this.findByMobile(normalized);
    if (!customer) return null;

    const attempts = Number(customer.otpAttempts || 0);
    if (attempts >= OTP_MAX_ATTEMPTS) return null;

    const submitted = String(otpCode).trim();
    const storedOtp = decryptAtRest(customer.otpCode);
    const matches = storedOtp ? safeEqual(storedOtp, submitted) : false;
    if (!storedOtp || !matches) {
      await this.db.execute(
        'UPDATE customers SET otp_attempts = ?, updated_at = ? WHERE id = ?',
        [attempts + 1, new Date().toISOString(), customer.id]
      );
      return null;
    }
    if (customer.otpExpiresAt && new Date() > customer.otpExpiresAt) {
      return null;
    }

    const now = new Date().toISOString();
    await this.db.execute(
      'UPDATE customers SET otp_code = NULL, otp_expires_at = NULL, otp_attempts = 0, is_phone_verified = true, last_login_at = ?, updated_at = ? WHERE id = ?',
      [now, now, customer.id]
    );
    return await this.findById(customer.id);
  }

  async clearAll() {
    await this.db.execute('DELETE FROM customer_sessions');
    await this.db.execute('DELETE FROM customers');
  }

  async count() {
    const row = await this.db.queryOne('SELECT COUNT(*) as c FROM customers');
    return row?.c || 0;
  }

  async banCustomer(id, reason = 'FRAUDULENT_PAYMENT_INJECTION', options = {}) {
    if (!id) return null;
    const releasedAccounts = [];
    await this.db.transaction(async () => {
      const now = new Date().toISOString();
      const lastDevice = options.lastDevice || options.deviceInfo || null;
      await this.db.execute(
        "UPDATE customers SET status = 'BANNED', ban_reason = ?, banned_at = ?, last_device = COALESCE(?, last_device), updated_at = ? WHERE id = ?",
        [reason, now, lastDevice, now, id]
      );

      const activeSessions = await this.db.query(
        "SELECT id, receiving_account_id FROM payment_sessions WHERE customer_id = ? AND status IN ('INITIATED', 'QUEUED', 'ACTIVE', 'PROCESSING')",
        [id]
      );
      if (activeSessions.length > 0) {
        await this.db.execute(
          "UPDATE payment_sessions SET status = 'EXPIRED', completed_at = ?, updated_at = ? WHERE customer_id = ? AND status IN ('INITIATED', 'QUEUED', 'ACTIVE', 'PROCESSING')",
          [now, now, id]
        );
        for (const s of activeSessions) {
          if (s.receiving_account_id) {
            await this.db.execute(
              "UPDATE payment_receiving_accounts SET is_slot_busy = false, current_active_session_id = NULL, updated_at = ? WHERE id = ? AND current_active_session_id = ?",
              [now, s.receiving_account_id, s.id]
            );
            releasedAccounts.push(s.receiving_account_id);
          }
        }
      }
    });

    if (options.queueEngine && typeof options.queueEngine.promoteNext === 'function') {
      for (const accountId of releasedAccounts) {
        options.queueEngine.promoteNext(accountId);
      }
    }

    return await this.findById(id);
  }

  async unbanCustomer(id) {
    if (!id) return null;
    const now = new Date().toISOString();
    await this.db.execute(
      "UPDATE customers SET status = 'ACTIVE', ban_reason = NULL, unbanned_at = ?, updated_at = ? WHERE id = ?",
      [now, now, id]
    );
    return await this.findById(id);
  }

  async isBanned(id) {
    if (!id) return false;
    const customer = await this.findById(id);
    return customer?.status === 'BANNED';
  }

  async createSecurityEvent(data) {
    const id = data.id || crypto.randomUUID();
    const now = new Date().toISOString();
    const sql = `
      INSERT INTO security_events (
        id, merchant_id, customer_id, payment_session_id, event_type,
        source, sender, device_info, raw_message, normalized_message,
        extracted_amount, extracted_reference, parser_results, verification_results,
        fraud_reason, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    await this.db.execute(sql, [
      id,
      data.merchantId || null,
      data.customerId || null,
      data.paymentSessionId || null,
      data.eventType || 'FRAUDULENT_PAYMENT_INJECTION',
      data.source || null,
      data.sender || null,
      data.deviceInfo || null,
      data.rawMessage || '',
      data.normalizedMessage || null,
      data.extractedAmount || null,
      data.extractedReference || null,
      typeof data.parserResults === 'object' ? JSON.stringify(data.parserResults) : (data.parserResults || '{}'),
      typeof data.verificationResults === 'object' ? JSON.stringify(data.verificationResults) : (data.verificationResults || '{}'),
      data.fraudReason || 'FRAUDULENT_PAYMENT_INJECTION',
      typeof data.metadata === 'object' ? JSON.stringify(data.metadata) : (data.metadata || '{}'),
      now
    ]);
    return await this.db.queryOne('SELECT * FROM security_events WHERE id = ?', [id]);
  }

  async getSecurityEvents(customerId = null, limit = 100) {
    const mapSecRow = (row) => {
      let meta = {};
      try { meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {}); } catch {}
      return {
        ...row,
        customerId: row.customer_id,
        paymentSessionId: row.payment_session_id,
        eventType: row.event_type,
        rawMessage: row.raw_message,
        normalizedMessage: row.normalized_message,
        extractedAmount: row.extracted_amount,
        extractedReference: row.extracted_reference,
        fraudReason: row.fraud_reason,
        createdAt: row.created_at,
        metadata: meta,
        autoBanApplied: meta.autoBanApplied !== undefined ? Boolean(meta.autoBanApplied) : (row.event_type === 'FRAUDULENT_PAYMENT_INJECTION'),
        banSuppressed: meta.banSuppressed !== undefined ? Boolean(meta.banSuppressed) : false
      };
    };

    if (customerId) {
      const rows = await this.db.query(
        'SELECT * FROM security_events WHERE customer_id = ? ORDER BY created_at DESC LIMIT ?',
        [customerId, limit]
      );
      return rows.map(mapSecRow);
    }
    const rows = await this.db.query(
      'SELECT se.*, c.name as customer_name, c.email as customer_email, c.mobile_number as customer_phone FROM security_events se LEFT JOIN customers c ON se.customer_id = c.id ORDER BY se.created_at DESC LIMIT ?',
      [limit]
    );
    return rows.map(mapSecRow);
  }

  async findAllBanned(searchQuery = '') {
    let sql = `
      SELECT c.*,
             se.id as security_event_id,
             se.event_type,
             se.source as event_source,
             se.sender as event_sender,
             se.device_info as event_device_info,
             se.fraud_reason as event_fraud_reason,
             se.raw_message as event_raw_message,
             se.created_at as event_created_at,
             ps.id as session_id,
             ps.order_id,
             ps.amount_paise,
             ps.status as session_status
      FROM customers c
      LEFT JOIN LATERAL (
        SELECT * FROM security_events e WHERE e.customer_id = c.id ORDER BY e.created_at DESC LIMIT 1
      ) se ON true
      LEFT JOIN payment_sessions ps ON ps.id = se.payment_session_id
      WHERE c.status = 'BANNED'
    `;
    const params = [];
    if (searchQuery && searchQuery.trim()) {
      const q = `%${searchQuery.trim()}%`;
      sql += ` AND (c.name ILIKE ? OR c.email ILIKE ? OR c.mobile_number ILIKE ?)`;
      params.push(q, q, q);
    }
    sql += ` ORDER BY COALESCE(c.banned_at, c.updated_at) DESC`;

    const rows = await this.db.query(sql, params);
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      email: r.email,
      phone: r.mobile_number,
      mobileNumber: r.mobile_number,
      status: r.status,
      bannedAt: r.banned_at || r.event_created_at || r.updated_at,
      banReason: r.ban_reason || r.event_fraud_reason || 'FRAUDULENT_PAYMENT_INJECTION',
      paymentSession: r.order_id ? `#${r.order_id}` : (r.payment_session_id || 'N/A'),
      orderId: r.order_id || null,
      sessionId: r.session_id || null,
      lastDevice: r.last_device || r.event_device_info || 'Device Web Client',
      source: r.event_source || 'SMS',
      securityEventId: r.security_event_id || null,
      rawMessage: r.event_raw_message || null
    }));
  }

  async getBanEvidence(customerId) {
    const customer = await this.findById(customerId);
    if (!customer) return null;

    const events = await this.getSecurityEvents(customerId, 50);
    const triggerEvent = events.find(e => e.eventType === 'FRAUDULENT_PAYMENT_INJECTION') || events[0] || null;

    let session = null;
    if (triggerEvent?.paymentSessionId || triggerEvent?.payment_session_id) {
      const sessId = triggerEvent.paymentSessionId || triggerEvent.payment_session_id;
      session = await this.db.queryOne('SELECT * FROM payment_sessions WHERE id = ?', [sessId]);
    } else {
      session = await this.db.queryOne('SELECT * FROM payment_sessions WHERE customer_id = ? ORDER BY created_at DESC LIMIT 1', [customerId]);
    }

    const allSessions = await this.db.query(
      'SELECT status, amount_paise FROM payment_sessions WHERE customer_id = ?',
      [customerId]
    );
    const totalOrders = allSessions.length;
    const totalSpentPaise = allSessions
      .filter(s => s.status === 'SUCCESS')
      .reduce((sum, s) => sum + Number(s.amount_paise || 0), 0);

    const rawVerbatim = triggerEvent?.rawMessage || triggerEvent?.raw_message || 'No raw message preserved.';

    return {
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        phone: customer.mobileNumber,
        status: customer.status,
        createdAt: customer.createdAt,
        bannedAt: customer.bannedAt || triggerEvent?.createdAt || customer.updatedAt,
        banReason: customer.banReason || triggerEvent?.fraudReason || 'FRAUDULENT_PAYMENT_INJECTION',
        lastDevice: customer.lastDevice || triggerEvent?.device_info || 'Device Web Client',
        totalOrders,
        totalSpentPaise,
        totalSpentRupees: (totalSpentPaise / 100).toFixed(2)
      },
      banDetails: {
        banType: customer.banReason === 'MANUAL_BAN' ? 'MANUAL' : 'AUTOMATIC',
        triggerEvent: triggerEvent ? (triggerEvent.eventType || triggerEvent.event_type) : (customer.banReason || 'FRAUDULENT_PAYMENT_INJECTION'),
        triggerTimestamp: customer.bannedAt || triggerEvent?.createdAt || null,
        paymentSessionId: session ? session.id : (triggerEvent?.paymentSessionId || null),
        orderId: session ? session.order_id : null,
        sessionAmountPaise: session ? session.amount_paise : null,
        sessionAmountRupees: session ? (Number(session.amount_paise) / 100).toFixed(2) : null
      },
      rawEvidence: rawVerbatim,
      rawEvidenceObject: {
        rawMessage: rawVerbatim,
        normalizedMessage: triggerEvent?.normalizedMessage || triggerEvent?.normalized_message || null,
        extractedAmount: triggerEvent?.extractedAmount || triggerEvent?.extracted_amount || null,
        extractedReference: triggerEvent?.extractedReference || triggerEvent?.extracted_reference || null
      },
      observationMetadata: {
        source: triggerEvent?.source || 'SMS',
        sender: triggerEvent?.sender || customer.mobileNumber,
        receiver: 'SIM Slot #1',
        deviceId: triggerEvent?.device_info || customer.lastDevice || 'android-gateway'
      },
      discrepancyAnalysis: {
        customerPhone: customer.mobileNumber,
        observationSender: triggerEvent?.sender || customer.mobileNumber,
        registeredBankHeader: 'NO (Personal sender match)',
        sessionAmount: session ? `Rs ${(Number(session.amount_paise) / 100).toFixed(2)}` : 'N/A',
        messageAmount: triggerEvent?.extractedAmount || 'N/A',
        sessionRef: session?.id ? session.id.substring(0, 12) : 'N/A',
        messageRef: triggerEvent?.extractedReference || 'N/A',
        result: 'FRAUDULENT_PAYMENT_INJECTION confirmed.'
      },
      timeline: {
        sessionCreated: session?.created_at || null,
        fakeObservationReceived: triggerEvent?.createdAt || null,
        paymentRejected: triggerEvent?.createdAt || null,
        autoBanExecuted: customer.bannedAt || triggerEvent?.createdAt || null
      },
      session: session ? {
        id: session.id,
        orderId: session.order_id,
        amount: session.amount_paise ? `₹${(Number(session.amount_paise) / 100).toFixed(2)}` : null,
        amountPaise: session.amount_paise?.toString(),
        createdAt: session.created_at,
        state: session.status
      } : null,
      securityEvent: triggerEvent ? {
        id: triggerEvent.id,
        detectionTime: triggerEvent.createdAt,
        fraudReason: triggerEvent.fraudReason || triggerEvent.fraud_reason,
        source: triggerEvent.source,
        sender: triggerEvent.sender,
        deviceInfo: triggerEvent.device_info,
        eventType: triggerEvent.eventType || triggerEvent.event_type
      } : null,
      history: events.map(e => ({
        id: e.id,
        eventType: e.eventType || e.event_type,
        fraudReason: e.fraudReason || e.fraud_reason,
        source: e.source,
        sender: e.sender,
        timestamp: e.createdAt || e.created_at,
        rawMessage: e.rawMessage || e.raw_message
      }))
    };
  }

  mapRow(row) {
    return {
      id: row.id,
      name: row.name,
      fullName: row.name,
      email: row.email,
      mobileNumber: row.mobile_number,
      phoneNumber: row.mobile_number,
      passwordHash: row.password_hash,
      otpCode: decryptAtRest(row.otp_code),
      otpExpiresAt: row.otp_expires_at ? new Date(row.otp_expires_at) : null,
      otpAttempts: Number(row.otp_attempts || 0),
      isPhoneVerified: Boolean(row.is_phone_verified),
      status: row.status,
      banReason: row.ban_reason || null,
      bannedAt: row.banned_at ? new Date(row.banned_at) : null,
      unbannedAt: row.unbanned_at ? new Date(row.unbanned_at) : null,
      lastDevice: row.last_device || null,
      lastLoginAt: row.last_login_at ? new Date(row.last_login_at) : null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }
}
