/**
 * Creates (or resets the password of) an Admin 2 (read-only auditor).
 * Usage: SEED_AUDITOR_EMAIL=you@example.com SEED_AUDITOR_PASSWORD='...' npm run auditor:create
 */
import "dotenv/config";
import { db, disconnectDb } from "../src/lib/db";
import { hashPassword } from "../src/server/auth/password";
import { recordActivity } from "../src/server/services/activity";
import { passwordSchema, usernameSchema } from "../src/lib/validation";

async function main() {
  const email = process.env.SEED_AUDITOR_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_AUDITOR_PASSWORD;
  const name = process.env.SEED_AUDITOR_NAME?.trim() || "Admin 2";
  if (!email || !password) {
    console.error("Set SEED_AUDITOR_EMAIL and SEED_AUDITOR_PASSWORD (in .env or the environment).");
    process.exit(1);
  }
  const check = passwordSchema.safeParse(password);
  if (!check.success) {
    console.error(`Password rejected: ${check.error.issues.map((i) => i.message).join("; ")}`);
    process.exit(1);
  }
  const wanted = process.env.SEED_AUDITOR_USERNAME?.trim() || email.split("@")[0].toLowerCase().replace(/[^a-z0-9_]/g, "_").padEnd(3, "_").slice(0, 30);
  const un = usernameSchema.safeParse(wanted);
  if (!un.success) {
    console.error(`Username rejected: ${un.error.issues.map((i) => i.message).join("; ")}`);
    process.exit(1);
  }
  const passwordHash = await hashPassword(password);
  const existing = await db.user.findUnique({ where: { email } });
  if (existing && existing.role !== "AUDITOR") {
    console.error("That email belongs to a user who is not an Admin 2. Use a different email.");
    process.exit(1);
  }
  if (!existing) {
    const taken = await db.user.findUnique({ where: { username: un.data } });
    if (taken) {
      console.error(`The username "${un.data}" is taken. Set SEED_AUDITOR_USERNAME to another one.`);
      process.exit(1);
    }
  }
  const saved = await db.user.upsert({
    where: { email },
    update: { passwordHash, failedLoginCount: 0, lockedUntil: null, status: "ACTIVE" },
    create: { email, name, username: un.data, role: "AUDITOR", status: "ACTIVE", passwordHash },
  });
  await recordActivity({ actor: null, ip: null, userAgent: "cli:auditor:create" }, { type: "auditor.created", actor: { type: "SYSTEM", name: "cli" }, targetUserId: saved.id, metadata: { username: saved.username, email, reset: !!existing } });
  console.log(`${existing ? "Updated" : "Created"} Admin 2 ${email} (username: ${existing?.username ?? un.data})`);
}
main().then(() => disconnectDb()).catch(async (e) => { console.error(e); await disconnectDb(); process.exit(1); });
