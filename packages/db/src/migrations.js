import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function getMigrationsDir() {
  if (process.env.MIGRATIONS_DIR) return path.resolve(process.env.MIGRATIONS_DIR);
  return path.resolve(__dirname, '../../../migrations');
}

const ADVISORY_LOCK_KEY = '5961806049129785415';

export function listMigrationFiles(dir = getMigrationsDir()) {
  if (!fs.existsSync(dir)) {
    throw new Error(`Migrations directory not found: ${dir}`);
  }
  return fs.readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .map((f) => {
      const file = path.join(dir, f);
      const sql = fs.readFileSync(file, 'utf8');
      return {
        id: f.replace(/\.sql$/, ''),
        file,
        sql,
        checksum: crypto.createHash('sha256').update(sql).digest('hex')
      };
    });
}

export async function applyMigrations(db, opts = {}) {
  const log = opts.log || (() => {});
  const files = listMigrationFiles(opts.dir);
  const client = await db.pool.connect();
  const applied = [];
  const skipped = [];
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [ADVISORY_LOCK_KEY]);
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id TEXT PRIMARY KEY,
          checksum TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      const { rows } = await client.query('SELECT id, checksum FROM schema_migrations');
      const done = new Map(rows.map((r) => [r.id, r.checksum]));

      for (const m of files) {
        if (done.has(m.id)) {
          if (done.get(m.id) !== m.checksum) {
            throw new Error(
              `Migration ${m.id} was already applied but the file has changed since. ` +
              'Never edit an applied migration; add a new numbered file instead.'
            );
          }
          skipped.push(m.id);
          log(`skip   ${m.id} (already applied)`);
          continue;
        }
        log(`apply  ${m.id} ...`);
        try {
          await client.query('BEGIN');
          await client.query(m.sql);
          await client.query('INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)', [m.id, m.checksum]);
          await client.query('COMMIT');
        } catch (err) {
          try { await client.query('ROLLBACK'); } catch { }
          err.message = `Migration ${m.id} failed and was rolled back: ${err.message}`;
          throw err;
        }
        applied.push(m.id);
        log(`done   ${m.id}`);
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [ADVISORY_LOCK_KEY]).catch(() => {});
    }
  } finally {
    client.release();
  }
  return { applied, skipped };
}
