import crypto from 'node:crypto';
import { blindIndex, blindIndexMatches, safeEqual, issueDeviceCredential, verifyDeviceCredential } from '@youpi/common';

const INDEX_NS = 'devtok';

export class DeviceRepository {
  constructor(db) {
    this.db = db;
  }

  create(data) {
    const id = data.id || `dev_${crypto.randomUUID()}`;
    const deviceToken = data.deviceToken || issueDeviceCredential(id);
    const now = new Date().toISOString();
    const status = data.status || 'ACTIVE';

    const sql = `
      INSERT INTO devices (
        id, customer_id, public_key, fingerprint_hash, user_agent,
        platform, browser, timezone, language, screen_signature,
        device_token, status, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    this.db.execute(sql, [
      id,
      data.customerId || null,
      data.publicKey,
      data.fingerprintHash,
      data.userAgent || null,
      data.platform || null,
      data.browser || null,
      data.timezone || null,
      data.language || null,
      data.screenSignature || null,
      blindIndex(deviceToken, INDEX_NS),
      status,
      now,
      now
    ]);

    const created = this.findById(id);
    return created ? { ...created, deviceToken } : null;
  }

  findById(id) {
    if (!id) return null;
    const row = this.db.queryOne('SELECT * FROM devices WHERE id = ?', [id]);
    return row ? this.mapRow(row) : null;
  }

  verifyToken(deviceId, presentedToken) {
    if (!deviceId || typeof deviceId !== 'string' || !presentedToken || typeof presentedToken !== 'string') {
      return false;
    }
    const row = this.db.queryOne(
      'SELECT id, device_token, status FROM devices WHERE id = ?',
      [deviceId]
    );
    if (!row || row.status !== 'ACTIVE' || !row.device_token) {
      return false;
    }

    if (presentedToken.startsWith(`devtok_${deviceId}.`) && !verifyDeviceCredential(deviceId, presentedToken)) {
      return false;
    }

    if (blindIndexMatches(presentedToken, row.device_token, INDEX_NS)) {
      return true;
    }

    if (safeEqual(presentedToken, row.device_token)) {
      try {
        this.db.execute('UPDATE devices SET device_token = ? WHERE id = ?', [blindIndex(presentedToken, INDEX_NS), row.id]);
      } catch {}
      return true;
    }

    return false;
  }

  rotateToken(deviceId) {
    if (!deviceId) return null;
    const row = this.db.queryOne('SELECT id, status FROM devices WHERE id = ?', [deviceId]);
    if (!row || row.status !== 'ACTIVE') return null;
    const freshToken = issueDeviceCredential(deviceId);
    const now = new Date().toISOString();
    this.db.execute(
      'UPDATE devices SET device_token = ?, last_seen_at = ? WHERE id = ?',
      [blindIndex(freshToken, INDEX_NS), now, deviceId]
    );
    return freshToken;
  }

  findByToken(token) {
    if (!token) return null;
    let row = this.db.queryOne(
      'SELECT * FROM devices WHERE device_token = ? AND status = ?',
      [blindIndex(token, INDEX_NS), 'ACTIVE']
    );
    if (!row && typeof token === 'string' && token.startsWith('devtok_')) {
      const legacy = this.db.queryOne(
        'SELECT * FROM devices WHERE device_token = ? AND status = ?',
        [token, 'ACTIVE']
      );
      if (legacy) {
        try {
          this.db.execute('UPDATE devices SET device_token = ? WHERE id = ?', [blindIndex(token, INDEX_NS), legacy.id]);
        } catch {}
        row = legacy;
      }
    }
    return row ? this.mapRow(row) : null;
  }

  findByPublicKey(publicKey) {
    if (!publicKey) return null;
    const row = this.db.queryOne('SELECT * FROM devices WHERE public_key = ? LIMIT 1', [publicKey]);
    return row ? this.mapRow(row) : null;
  }

  findByCustomerAndFingerprint(customerId, fingerprintHash) {
    if (!customerId || !fingerprintHash) return null;
    const row = this.db.queryOne(
      'SELECT * FROM devices WHERE customer_id = ? AND fingerprint_hash = ? AND status = "ACTIVE" LIMIT 1',
      [customerId, fingerprintHash]
    );
    return row ? this.mapRow(row) : null;
  }

  findByCustomerId(customerId) {
    if (!customerId) return [];
    const rows = this.db.query(
      'SELECT * FROM devices WHERE customer_id = ? ORDER BY last_seen_at DESC',
      [customerId]
    );
    return rows.map(r => this.mapRow(r));
  }

  associateCustomer(deviceId, customerId) {
    const now = new Date().toISOString();
    this.db.execute(
      'UPDATE devices SET customer_id = ?, last_seen_at = ? WHERE id = ?',
      [customerId, now, deviceId]
    );
    return this.findById(deviceId);
  }

  touch(deviceId) {
    if (!deviceId) return;
    try {
      this.db.execute(
        'UPDATE devices SET last_seen_at = ? WHERE id = ?',
        [new Date().toISOString(), deviceId]
      );
    } catch {}
  }

  update(id, data) {
    const fields = [];
    const values = [];

    if (data.customerId !== undefined) {
      fields.push('customer_id = ?');
      values.push(data.customerId);
    }
    if (data.fingerprintHash !== undefined) {
      fields.push('fingerprint_hash = ?');
      values.push(data.fingerprintHash);
    }
    if (data.status !== undefined) {
      fields.push('status = ?');
      values.push(data.status);
    }
    if (data.deviceToken !== undefined) {
      fields.push('device_token = ?');
      values.push(blindIndex(data.deviceToken, INDEX_NS));
    }

    fields.push('last_seen_at = ?');
    values.push(new Date().toISOString());

    values.push(id);
    this.db.execute(`UPDATE devices SET ${fields.join(', ')} WHERE id = ?`, values);
    return this.findById(id);
  }

  mapRow(row) {
    return {
      id: row.id,
      customerId: row.customer_id,
      publicKey: row.public_key,
      fingerprintHash: row.fingerprint_hash,
      userAgent: row.user_agent,
      platform: row.platform,
      browser: row.browser,
      timezone: row.timezone,
      language: row.language,
      screenSignature: row.screen_signature,
      deviceToken: null,
      status: row.status,
      createdAt: new Date(row.created_at),
      lastSeenAt: new Date(row.last_seen_at)
    };
  }
}
