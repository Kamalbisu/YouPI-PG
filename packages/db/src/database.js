import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';

const { Pool, types } = pg;

let parsersInstalled = false;
function installTypeParsers() {
  if (parsersInstalled) return;
  parsersInstalled = true;
  types.setTypeParser(types.builtins.INT8, (v) => (v === null ? null : Number(v)));
  types.setTypeParser(types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
  types.setTypeParser(types.builtins.TIMESTAMPTZ, (v) => {
    if (v === null) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : d.toISOString();
  });
}

export function toPgPlaceholders(sql) {
  if (!sql.includes('?')) return sql;
  let out = '';
  let n = 0;
  let i = 0;
  const len = sql.length;
  while (i < len) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += ch;
      i++;
      while (i < len) {
        out += sql[i];
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { out += sql[i + 1]; i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < len && sql[i] !== '\n') { out += sql[i]; i++; }
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? len : end + 2;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '?') {
      n++;
      out += `$${n}`;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export function resolveConnection(connectionString, options = {}) {
  let cleaned = connectionString;
  let urlMode = null;
  try {
    const url = new URL(connectionString);
    urlMode = url.searchParams.get('sslmode');
    if (urlMode !== null) {
      url.searchParams.delete('sslmode');
      cleaned = url.toString();
    }
  } catch {
  }
  if (options.ssl !== undefined) return { connectionString: cleaned, ssl: options.ssl };

  const mode = String(urlMode || process.env.PGSSLMODE || '').toLowerCase();
  if (!mode || mode === 'disable' || mode === 'allow' || mode === 'prefer') {
    return { connectionString: cleaned, ssl: false };
  }
  if (mode === 'require' || mode === 'no-verify') {
    return { connectionString: cleaned, ssl: { rejectUnauthorized: false } };
  }
  if (mode === 'verify-ca' || mode === 'verify-full') {
    const ssl = { rejectUnauthorized: true };
    if (process.env.PGSSLROOTCERT) ssl.ca = fs.readFileSync(process.env.PGSSLROOTCERT, 'utf8');
    return { connectionString: cleaned, ssl };
  }
  throw new Error(`Unsupported sslmode "${mode}". Use disable, require, verify-ca or verify-full.`);
}

export class MigrationsRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MigrationsRequiredError';
  }
}

const txStorage = new AsyncLocalStorage();

export class Database {
  constructor(options = {}) {
    installTypeParsers();
    const raw = options.connectionString || process.env.DATABASE_URL;
    if (!raw && !options.pool) {
      throw new Error(
        'DATABASE_URL is not set. Set it to a PostgreSQL connection string, e.g. ' +
        'postgres://user:password@host:5432/dbname (see .env.example), then run `npm run migrate`.'
      );
    }
    this.searchPath = options.searchPath || null;
    if (options.pool) {
      this.pool = options.pool;
    } else {
      const { connectionString, ssl } = resolveConnection(raw, options);
      this.pool = new Pool({
        connectionString,
        ssl,
        max: options.max || Number(process.env.DATABASE_POOL_MAX) || 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS) || 10_000,
        ...(this.searchPath ? { options: `-c search_path=${this.searchPath}` } : {})
      });
    }
    this.pool.on('error', (err) => {
      console.error('[db] idle PostgreSQL client error:', err.message);
    });
  }

  _txClient() {
    const store = txStorage.getStore();
    return store && store.db === this ? store.client : null;
  }

  async _run(sql, params = []) {
    const text = toPgPlaceholders(sql);
    const client = this._txClient();
    return client ? client.query(text, params) : this.pool.query(text, params);
  }

  async execute(sql, params = []) {
    const res = await this._run(sql, params);
    const rowCount = res.rowCount ?? 0;
    return { changes: rowCount, rowCount, rows: res.rows || [] };
  }

  async run(sql, params = []) {
    return this.execute(sql, params);
  }

  async query(sql, params = []) {
    const res = await this._run(sql, params);
    return res.rows;
  }

  async queryOne(sql, params = []) {
    const res = await this._run(sql, params);
    return res.rows[0];
  }

  async exec(sql) {
    const client = this._txClient();
    if (client) await client.query(sql);
    else await this.pool.query(sql);
  }

  async transaction(callback) {
    if (this._txClient()) return callback();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await txStorage.run({ db: this, client }, callback);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { }
      throw err;
    } finally {
      client.release();
    }
  }

  async assertMigrated(opts = {}) {
    const { listMigrationFiles } = await import('./migrations.js');
    const expected = opts.expected || listMigrationFiles().map((m) => m.id);
    let applied = [];
    try {
      const rows = await this.query('SELECT id FROM schema_migrations');
      applied = rows.map((r) => r.id);
    } catch (err) {
      if (err && err.code === '42P01') {
        throw new MigrationsRequiredError(
          'The database schema has not been created (table schema_migrations is missing). ' +
          'Run `npm run migrate` with DATABASE_URL set, then start the app again.'
        );
      }
      throw err;
    }
    const missing = expected.filter((id) => !applied.includes(id));
    if (missing.length > 0) {
      throw new MigrationsRequiredError(
        `The database is behind: ${missing.length} migration(s) not applied (${missing.join(', ')}). ` +
        'Run `npm run migrate` with DATABASE_URL set, then start the app again.'
      );
    }
    return applied;
  }

  async close() {
    await this.pool.end();
  }
}

let defaultDbInstance = null;

export function getDatabase(options = {}) {
  if (!defaultDbInstance) {
    defaultDbInstance = new Database(options);
  }
  return defaultDbInstance;
}

export async function closeDefaultDatabase() {
  if (defaultDbInstance) {
    const db = defaultDbInstance;
    defaultDbInstance = null;
    await db.close();
  }
}

export async function initDatabase(db = getDatabase()) {
  const { applyMigrations } = await import('./migrations.js');
  if (String(process.env.YOUPI_AUTO_MIGRATE || '').toLowerCase() === 'true') {
    await applyMigrations(db);
  }
  await db.assertMigrated();
  const { seedDefaults } = await import('./migrate.js');
  const seeded = await seedDefaults(db);
  return { db, defaultMerchant: seeded.defaultMerchant };
}
