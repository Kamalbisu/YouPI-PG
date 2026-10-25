import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyMigrations, listMigrationFiles, MigrationsRequiredError } from '../index.js';
import { createTestDatabase } from '../testing.js';

const CORE_TABLES = [
  'merchants', 'payment_receiving_accounts', 'customers', 'customer_sessions', 'devices',
  'payment_sessions', 'payment_observations', 'webhook_deliveries', 'support_tickets',
  'ticket_messages', 'audit_logs', 'security_events', 'schema_migrations'
];

async function tableNames(db) {
  const rows = await db.query(
    'SELECT table_name FROM information_schema.tables WHERE table_schema = ?',
    [db.testSchema]
  );
  return rows.map((r) => r.table_name);
}

async function indexNames(db) {
  const rows = await db.query('SELECT indexname FROM pg_indexes WHERE schemaname = ?', [db.testSchema]);
  return rows.map((r) => r.indexname);
}

describe('Versioned SQL migrations (PostgreSQL)', () => {
  const dbs = [];
  const make = async (opts) => {
    const db = await createTestDatabase(opts);
    dbs.push(db);
    return db;
  };
  after(async () => {
    for (const db of dbs) await db.destroy();
  });

  test('migration files are numbered, ordered and 0001_init exists', () => {
    const files = listMigrationFiles();
    assert.ok(files.length >= 1);
    assert.equal(files[0].id, '0001_init');
    const ids = files.map((f) => f.id);
    assert.deepEqual(ids, [...ids].sort());
  });

  test('a fresh database gets every core table and the integrity indexes', async () => {
    const db = await make();
    const tables = await tableNames(db);
    for (const t of CORE_TABLES) assert.ok(tables.includes(t), `missing table ${t}`);
    const indexes = await indexNames(db);
    for (const idx of [
      'idx_one_slot_per_receiving_account',
      'idx_single_active_session_per_order',
      'idx_payment_sessions_attributed_obs',
      'idx_payment_sessions_idempotency',
      'idx_observations_account_fingerprint',
      'idx_observations_unique_attributed_bank_ref'
    ]) {
      assert.ok(indexes.includes(idx), `missing index ${idx}`);
    }
  });

  test('devices is created before payment_sessions (foreign key order)', () => {
    const sql = listMigrationFiles()[0].sql;
    const order = [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_]+)/gi)].map((m) => m[1].toLowerCase());
    assert.ok(order.indexOf('devices') !== -1 && order.indexOf('devices') < order.indexOf('payment_sessions'));
  });

  test('running the migrator twice is a no-op the second time and records each file once', async () => {
    const db = await make({ migrate: false });
    const first = await applyMigrations(db);
    assert.deepEqual(first.applied, listMigrationFiles().map((f) => f.id));
    assert.deepEqual(first.skipped, []);
    const second = await applyMigrations(db);
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.skipped, first.applied);
    const rows = await db.query('SELECT id FROM schema_migrations ORDER BY id');
    assert.deepEqual(rows.map((r) => r.id), first.applied);
  });

  test('concurrent migrators serialise on the advisory lock and apply each file once', async () => {
    const db = await make({ migrate: false });
    const results = await Promise.all([applyMigrations(db), applyMigrations(db), applyMigrations(db)]);
    const totalApplied = results.reduce((n, r) => n + r.applied.length, 0);
    assert.equal(totalApplied, listMigrationFiles().length);
  });

  test('assertMigrated fails with a clear message on an unmigrated database', async () => {
    const db = await make({ migrate: false });
    await assert.rejects(() => db.assertMigrated(), (err) => {
      assert.ok(err instanceof MigrationsRequiredError);
      assert.match(err.message, /npm run migrate/);
      return true;
    });
  });

  test('assertMigrated passes once migrated and fails again when a file is pending', async () => {
    const db = await make();
    await db.assertMigrated();
    await assert.rejects(() => db.assertMigrated({ expected: ['0001_init', '9999_pending'] }), /9999_pending/);
  });

  test('a failing migration is rolled back completely and not recorded', async () => {
    const db = await make({ migrate: false });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
    try {
      fs.writeFileSync(path.join(dir, '0001_ok.sql'), 'CREATE TABLE ok_table (id INT);');
      fs.writeFileSync(path.join(dir, '0002_bad.sql'), 'CREATE TABLE half_table (id INT); SELECT * FROM does_not_exist;');
      await assert.rejects(() => applyMigrations(db, { dir }), /0002_bad failed and was rolled back/);
      const tables = await tableNames(db);
      assert.ok(tables.includes('ok_table'));
      assert.ok(!tables.includes('half_table'));
      const rows = await db.query('SELECT id FROM schema_migrations');
      assert.deepEqual(rows.map((r) => r.id), ['0001_ok']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('editing an already applied migration is refused', async () => {
    const db = await make({ migrate: false });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
    try {
      fs.writeFileSync(path.join(dir, '0001_a.sql'), 'CREATE TABLE a_table (id INT);');
      await applyMigrations(db, { dir });
      fs.writeFileSync(path.join(dir, '0001_a.sql'), 'CREATE TABLE a_table (id INT, extra INT);');
      await assert.rejects(() => applyMigrations(db, { dir }), /file has changed/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
