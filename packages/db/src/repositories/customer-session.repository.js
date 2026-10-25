import crypto from 'node:crypto';
import { blindIndex } from '@youpi/common';

const INDEX_NS = 'csess';

export class CustomerSessionRepository {
  constructor(db, customerRepo = null) {
    this.db = db;
    this.customerRepo = customerRepo;
  }

  create(data) {
    const id = crypto.randomUUID();
    const token = `csess_${crypto.randomBytes(32).toString('hex')}`;
    const ttlHours = data.ttlHours || 720;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlHours * 3600 * 1000);

    const sql = `
      INSERT INTO customer_sessions (id, customer_id, token, expires_at, is_active, ip_address, user_agent, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
    `;

    this.db.execute(sql, [
      id,
      data.customerId,
      blindIndex(token, INDEX_NS),
      expiresAt.toISOString(),
      data.ipAddress || null,
      data.userAgent || null,
      now.toISOString(),
      now.toISOString()
    ]);

    return {
      id,
      customerId: data.customerId,
      token,
      expiresAt,
      isActive: true,
      createdAt: now
    };
  }

  findByToken(token) {
    if (!token || typeof token !== 'string') return null;

    const row = this.db.queryOne(
      'SELECT * FROM customer_sessions WHERE token = ? AND is_active = 1',
      [blindIndex(token, INDEX_NS)]
    );

    if (!row && typeof token === 'string' && token.startsWith('csess_') && token.length < 100) {
      const legacy = this.db.queryOne(
        'SELECT * FROM customer_sessions WHERE token = ? AND is_active = 1',
        [token]
      );
      if (legacy) {
        try {
          this.db.execute('UPDATE customer_sessions SET token = ? WHERE id = ?', [blindIndex(token, INDEX_NS), legacy.id]);
        } catch {}
        return this.findByToken(token);
      }
    }

    if (!row) return null;

    const expiresAt = new Date(row.expires_at);
    if (expiresAt.getTime() <= Date.now()) {
      try {
        this.db.execute('UPDATE customer_sessions SET is_active = 0, updated_at = ? WHERE id = ?', [
          new Date().toISOString(),
          row.id
        ]);
      } catch {}
      return null;
    }

    const session = {
      id: row.id,
      customerId: row.customer_id,
      expiresAt,
      isActive: Boolean(row.is_active),
      createdAt: new Date(row.created_at)
    };

    let customer = null;
    if (this.customerRepo) {
      customer = this.customerRepo.findById(row.customer_id);
    } else {
      const custRow = this.db.queryOne('SELECT * FROM customers WHERE id = ?', [row.customer_id]);
      if (custRow) {
        customer = {
          id: custRow.id,
          name: custRow.name,
          email: custRow.email,
          mobileNumber: custRow.mobile_number,
          status: custRow.status,
          createdAt: new Date(custRow.created_at),
          updatedAt: new Date(custRow.updated_at)
        };
      }
    }

    if (!customer || customer.status !== 'ACTIVE') {
      return null;
    }

    return { session, customer };
  }

  revokeToken(token) {
    if (!token) return false;
    const now = new Date().toISOString();
    this.db.execute(
      'UPDATE customer_sessions SET is_active = 0, updated_at = ? WHERE token = ?',
      [now, blindIndex(token, INDEX_NS)]
    );
    this.db.execute(
      'UPDATE customer_sessions SET is_active = 0, updated_at = ? WHERE token = ?',
      [now, token]
    );
    return true;
  }

  revokeAllForCustomer(customerId) {
    if (!customerId) return;
    const now = new Date().toISOString();
    this.db.execute(
      'UPDATE customer_sessions SET is_active = 0, updated_at = ? WHERE customer_id = ?',
      [now, customerId]
    );
  }

  countActive() {
    const row = this.db.queryOne(
      'SELECT COUNT(*) as c FROM customer_sessions WHERE is_active = 1 AND expires_at > ?',
      [new Date().toISOString()]
    );
    return row?.c || 0;
  }
}
