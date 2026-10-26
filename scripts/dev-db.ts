/**
 * Starts a local, persistent PostgreSQL server (no Docker, no installer) for development.
 * Data lives in .local/pgdata. Usage: npm run db:local
 */
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";
import path from "node:path";

const dataDir = path.resolve(process.cwd(), ".local/pgdata");
const port = Number(process.env.LOCAL_DB_PORT ?? 5433);

async function main() {
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "postgres",
    password: "postgres",
    port,
    persistent: true,
  });
  if (!existsSync(path.join(dataDir, "PG_VERSION"))) await pg.initialise();
  await pg.start();
  try {
    await pg.createDatabase("youpi");
  } catch {
    /* already exists */
  }
  console.log(`DATABASE_URL=postgresql://postgres:postgres@localhost:${port}/youpi`);
  console.log("Local PostgreSQL is running. Press Ctrl+C to stop.");
  const stop = async () => {
    await pg.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  setInterval(() => {}, 1 << 30);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
