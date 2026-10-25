import crypto from 'node:crypto';
import pg from 'pg';
import { Database, resolveConnection } from './database.js';
import { applyMigrations } from './migrations.js';

const DEFAULT_TEST_URL = 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

export function getTestDatabaseUrl() {
  return process.env.TEST_DATABASE_URL || DEFAULT_TEST_URL;
}

async function withAdminClient(fn) {
  const { connectionString, ssl } = resolveConnection(getTestDatabaseUrl());
  const client = new pg.Client({ connectionString, ssl });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(
      `Cannot reach the test PostgreSQL server (${err.message}). ` +
      'Start one and set TEST_DATABASE_URL, e.g. postgres://postgres:postgres@127.0.0.1:5432/postgres. ' +
      'Tests create and drop their own throwaway schemas and never touch existing tables.'
    );
  }
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function createTestDatabase(options = {}) {
  const schema = `t_${crypto.randomBytes(8).toString('hex')}`;
  await withAdminClient((c) => c.query(`CREATE SCHEMA "${schema}"`));
  const db = new Database({
    connectionString: getTestDatabaseUrl(),
    searchPath: schema,
    max: options.max || 8
  });
  db.testSchema = schema;
  db.destroy = async () => {
    await db.close().catch(() => {});
    await withAdminClient((c) => c.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`));
  };
  if (options.migrate !== false) {
    await applyMigrations(db);
  }
  if (options.seed) {
    const { seedDefaults } = await import('./migrate.js');
    db.seed = await seedDefaults(db);
  }
  return db;
}
