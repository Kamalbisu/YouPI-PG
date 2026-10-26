/**
 * Creates (or resets the password of) an admin.
 * Usage: SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD='...' npm run admin:create
 */
import "dotenv/config";
import { db, disconnectDb } from "../src/lib/db";
import { hashPassword } from "../src/server/auth/password";
import { passwordSchema, usernameSchema } from "../src/lib/validation";

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  const name = process.env.SEED_ADMIN_NAME?.trim() || "Admin";
  if (!email || !password) {
    console.error("Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD (in .env or the environment).");
    process.exit(1);
  }
  const check = passwordSchema.safeParse(password);
  if (!check.success) {
    console.error(`Password rejected: ${check.error.issues.map((i) => i.message).join("; ")}`);
    process.exit(1);
  }
  const wanted = process.env.SEED_ADMIN_USERNAME?.trim() || email.split("@")[0].toLowerCase().replace(/[^a-z0-9_]/g, "_").padEnd(3, "_").slice(0, 30);
  const un = usernameSchema.safeParse(wanted);
  if (!un.success) {
    console.error(`Username rejected: ${un.error.issues.map((i) => i.message).join("; ")}`);
    process.exit(1);
  }
  const passwordHash = await hashPassword(password);
  const existing = await db.user.findUnique({ where: { email } });
  if (existing && existing.role !== "ADMIN") {
    console.error("That email belongs to a non-admin user. Use a different email.");
    process.exit(1);
  }
  if (!existing) {
    const taken = await db.user.findUnique({ where: { username: un.data } });
    if (taken) {
      console.error(`The username "${un.data}" is taken. Set SEED_ADMIN_USERNAME to another one.`);
      process.exit(1);
    }
  }
  await db.user.upsert({
    where: { email },
    update: { passwordHash, failedLoginCount: 0, lockedUntil: null, status: "ACTIVE" },
    create: { email, name, username: un.data, role: "ADMIN", status: "ACTIVE", passwordHash },
  });
  console.log(`${existing ? "Updated" : "Created"} admin ${email} (username: ${existing?.username ?? un.data})`);
}
main().then(() => disconnectDb()).catch(async (e) => { console.error(e); await disconnectDb(); process.exit(1); });
