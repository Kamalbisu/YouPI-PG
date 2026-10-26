import EmbeddedPostgres from "embedded-postgres";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let pg: EmbeddedPostgres | null = null;
let dir: string | null = null;

/**
 * Starts a throwaway real PostgreSQL server, applies every migration with `prisma migrate deploy`,
 * and points DATABASE_URL at it. Set TEST_DATABASE_URL to use an existing (empty, disposable) database instead.
 */
export default async function setup() {
  process.env.NODE_ENV = "test";
  process.env.APP_URL = "http://localhost:3000";
  process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.APP_SECRET = "test-secret-test-secret-test-secret";
  process.env.TRUST_PROXY = "false";
  process.env.PAYMENT_SIMULATOR_ENABLED = "true";

  if (process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  } else {
    const port = 5440 + Math.floor(Math.random() * 400);
    dir = mkdtempSync(path.join(os.tmpdir(), "youpi-test-pg-"));
    pg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "postgres", port, persistent: false });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("youpi_test");
    process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost:${port}/youpi_test`;
  }
  execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env } });

  return async () => {
    if (pg) await pg.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  };
}
