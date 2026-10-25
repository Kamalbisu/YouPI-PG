import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { reinitializeCustomerIdentity } from '../index.js';
import { createTestDatabase } from '../testing.js';

describe('Customer identity reset (PostgreSQL)', () => {
  let db;
  before(async () => {
    db = await createTestDatabase({ seed: true });
  });
  after(async () => {
    await db.destroy();
  });

  async function count(table) {
    const row = await db.queryOne(`SELECT count(*) AS c FROM ${table}`);
    return row.c;
  }

  test('reset wipes customers and customer sessions, detaches payment sessions, keeps merchants and accounts', async () => {
    const merchants = await db.query('SELECT id FROM merchants LIMIT 1');
    assert.ok(merchants.length >= 1, 'seed data must provide a merchant');
    const merchantId = merchants[0].id;

    const account = await db.queryOne('SELECT id FROM payment_receiving_accounts WHERE merchant_id = ? LIMIT 1', [merchantId]);
    assert.ok(account, 'seed data must provide a receiving account');

    for (const n of [1, 2]) {
      await db.execute(
        'INSERT INTO customers (id, name, email, mobile_number) VALUES (?, ?, ?, ?)',
        [`cust_${n}`, `Customer ${n}`, `c${n}@example.com`, `900000000${n}`]
      );
      await db.execute(
        'INSERT INTO customer_sessions (id, customer_id, token, expires_at) VALUES (?, ?, ?, now() + interval \'1 day\')',
        [`cs_${n}`, `cust_${n}`, `tok_${n}`]
      );
    }
    await db.execute(
      'INSERT INTO payment_sessions (id, merchant_id, customer_id, receiving_account_id, order_id, amount_paise) VALUES (?, ?, ?, ?, ?, ?)',
      ['pay_reset_1', merchantId, 'cust_1', account.id, 'order_reset_1', 10000]
    );

    const merchantsBefore = await count('merchants');
    const accountsBefore = await count('payment_receiving_accounts');
    assert.equal(await count('customers'), 2);
    assert.equal(await count('customer_sessions'), 2);

    const result = await reinitializeCustomerIdentity(db);
    assert.equal(result.success, true);

    assert.equal(await count('customers'), 0);
    assert.equal(await count('customer_sessions'), 0);
    assert.equal(await count('merchants'), merchantsBefore);
    assert.equal(await count('payment_receiving_accounts'), accountsBefore);

    const payment = await db.queryOne('SELECT customer_id FROM payment_sessions WHERE id = ?', ['pay_reset_1']);
    assert.ok(payment, 'payment session must survive the reset');
    assert.equal(payment.customer_id, null);
  });

  test('reset on an already-empty customer table is a safe no-op', async () => {
    const result = await reinitializeCustomerIdentity(db);
    assert.equal(result.success, true);
    assert.equal(await count('customers'), 0);
  });
});
