/**
 * Creates (or resets the password of) a Super Admin.
 * Usage: SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD='...' npm run admin:create
 */
import "dotenv/config";
import { db, disconnectDb } from "../src/lib/db";
import { hashPassword } from "../src/server/auth/password";
import { passwordSchema } from "../src/lib/validation";

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  const name = process.env.SEED_ADMIN_NAME ?? "Platform Admin";
  if (!email || !password) {
    console.error("Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD (in .env or the environment).");
    process.exit(1);
  }
  const check = passwordSchema.safeParse(password);
  if (!check.success) {
    console.error(`Password rejected: ${check.error.issues.map((i) => i.message).join("; ")}`);
    process.exit(1);
  }
  const passwordHash = await hashPassword(password);
  const existing = await db.user.findUnique({ where: { email } });
  if (existing && existing.role !== "SUPER_ADMIN") {
    console.error("That email belongs to a non-admin user. Use a different email.");
    process.exit(1);
  }
  await db.user.upsert({
    where: { email },
    update: { passwordHash, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null, status: "ACTIVE" },
    create: { email, name, role: "SUPER_ADMIN", status: "ACTIVE", passwordHash },
  });
  console.log(`${existing ? "Updated" : "Created"} Super Admin ${email}`);
}
main().then(() => disconnectDb()).catch(async (e) => { console.error(e); await disconnectDb(); process.exit(1); });
