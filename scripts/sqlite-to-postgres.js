#!/usr/bin/env node
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Database } from '../packages/db/src/index.js';

const TABLES = [
  'merchants',
  'payment_receiving_accounts',
  'customers',
  'customer_sessions',
  'devices',
  'payment_sessions',
  'payment_observations',
  'android_devices',
  'webhook_deliveries',
  'support_tickets',
  'ticket_messages',
  'audit_logs',
  'security_events'
];

const USAGE = `One-off copy of an old YouPI SQLite database into PostgreSQL.

Usage:
  DATABASE_URL=postgres://... [PGSSLMODE=require] node scripts/sqlite-to-postgres.js <path-to.sqlite> [--dry-run]

Run 'npm run migrate' first. Rows that already exist in PostgreSQL (same primary key or
unique index) are skipped, not overwritten. The whole copy is one transaction.`;

function convert(value, pgType) {
  if (value === null || value === undefined) return null;
  if (pgType === 'boolean') return value === true || value === 1 || value === 1n || value === '1' || value === 'true';
  if (pgType === 'timestamp with time zone') {
    if (typeof value === 'number') return new Date(value).toISOString();
    const text = String(value).trim();
    const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(text);
    const parsed = new Date(hasZone ? text : `${text.replace(' ', 'T')}Z`);
    if (Number.isNaN(parsed.getTime())) throw new Error(`Unparseable timestamp "${text}"`);
    return parsed.toISOString();
  }
  if (pgType === 'bigint' || pgType === 'integer') return typeof value === 'bigint' ? value.toString() : value;
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file || args.includes('--help')) {
    console.log(USAGE);
    process.exit(file ? 0 : 1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error(`SQLite file not found: ${file}`);
    process.exit(1);
  }

  const source = new DatabaseSync(file, { readOnly: true });
  const target = new Database();
  const client = await target.pool.connect();
  const summary = [];
  try {
    await client.query('BEGIN');
    for (const table of TABLES) {
      const exists = source.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      if (!exists) {
        summary.push({ table, read: 0, inserted: 0, skipped: 0, note: 'not in SQLite file' });
        continue;
      }
      const cols = await client.query(
        `SELECT column_name, data_type, is_identity, is_generated
           FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = $1`,
        [table]
      );
      const pgCols = new Map(
        cols.rows
          .filter((c) => c.is_identity !== 'YES' && c.is_generated !== 'ALWAYS')
          .map((c) => [c.column_name, c.data_type])
      );
      const liteCols = source.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      const shared = liteCols.filter((c) => pgCols.has(c));
      const dropped = liteCols.filter((c) => !pgCols.has(c));
      const rows = source.prepare(`SELECT ${shared.map((c) => `"${c}"`).join(', ')} FROM ${table} ORDER BY rowid`).all();
      const insertSql =
        `INSERT INTO ${table} (${shared.map((c) => `"${c}"`).join(', ')}) ` +
        `VALUES (${shared.map((_, i) => `$${i + 1}`).join(', ')}) ON CONFLICT DO NOTHING`;
      let inserted = 0;
      for (const row of rows) {
        const res = await client.query(insertSql, shared.map((c) => convert(row[c], pgCols.get(c))));
        inserted += res.rowCount;
      }
      summary.push({
        table,
        read: rows.length,
        inserted,
        skipped: rows.length - inserted,
        note: dropped.length ? `columns not in PostgreSQL ignored: ${dropped.join(', ')}` : ''
      });
    }
    if (dryRun) {
      await client.query('ROLLBACK');
      console.log('Dry run: nothing was written.');
    } else {
      await client.query('COMMIT');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`[sqlite-to-postgres] FAILED, nothing was written: ${err.message}`);
    process.exitCode = 1;
  } finally {
    client.release();
    await target.close();
    source.close();
  }
  for (const s of summary) {
    console.log(`${s.table.padEnd(28)} read ${String(s.read).padStart(6)}  inserted ${String(s.inserted).padStart(6)}  skipped ${String(s.skipped).padStart(6)} ${s.note}`);
  }
}

main();
