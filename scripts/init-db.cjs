const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[-] DATABASE_URL is not set. Example: postgres://user:password@host:5432/dbname');
    process.exit(1);
  }

  const rootDir = path.resolve(__dirname, '..');
  const dbUrl = (rel) => pathToFileURL(path.join(rootDir, rel)).href;

  const { Database } = await import(dbUrl('packages/db/src/database.js'));
  const { applyMigrations } = await import(dbUrl('packages/db/src/migrations.js'));
  const { seedDefaults } = await import(dbUrl('packages/db/src/migrate.js'));

  const db = new Database();
  try {
    console.log('[+] Applying migrations from /migrations ...');
    const { applied, skipped } = await applyMigrations(db, { log: (m) => console.log(`[migrate] ${m}`) });
    console.log(`[✓] Migrations applied: ${applied.length}, already up to date: ${skipped.length}`);

    const result = await seedDefaults(db);
    console.log(`[✓] Default merchant: ${result.defaultMerchant.businessName} (${result.defaultMerchant.id})`);

    const merchantCount = await db.queryOne('SELECT COUNT(*) AS count FROM merchants');
    const accountsCount = await db.queryOne('SELECT COUNT(*) AS count FROM payment_receiving_accounts');
    console.log(`[✓] Merchants: ${merchantCount.count}, receiving accounts: ${accountsCount.count}`);
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error('[-] Database initialization failed:', err.message);
  process.exit(1);
});
