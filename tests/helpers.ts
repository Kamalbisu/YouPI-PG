import { db } from "@/lib/db";
import { hashPassword } from "@/server/auth/password";
import type { Ctx } from "@/server/auth/types";

export const PASSWORD = "Correct-Horse-Battery-9";

/** Empties every table (including the append-only audit log) between suites. */
export async function resetDb() {
  const rows = await db.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (rows.length === 0) return;
  const names = rows.map((r) => `"${r.tablename}"`).join(", ");
  await db.$executeRawUnsafe(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
}

export const anonCtx = (ip = "203.0.113.5"): Ctx => ({ actor: null, ip, userAgent: "vitest" });

export async function makeAdmin(email = "admin@example.com") {
  return db.user.create({
    data: { email, name: "Admin", role: "SUPER_ADMIN", status: "ACTIVE", passwordHash: await hashPassword(PASSWORD) },
  });
}
