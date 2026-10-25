#!/usr/bin/env node
import { Database, applyMigrations } from './packages/db/src/index.js';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Example: DATABASE_URL=postgres://user:pass@host:5432/dbname npm run migrate');
    process.exit(1);
  }
  const db = new Database();
  try {
    const { applied, skipped } = await applyMigrations(db, { log: (m) => console.log(`[migrate] ${m}`) });
    console.log(`[migrate] complete: ${applied.length} applied, ${skipped.length} already up to date`);
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(`[migrate] FAILED: ${err.message}`);
  process.exit(1);
});
