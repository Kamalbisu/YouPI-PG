import { z } from "zod";
import { db } from "@/lib/db";
import { conflict } from "@/lib/errors";
import { emailSchema, nameSchema, parse, passwordSchema, usernameSchema } from "@/lib/validation";
import { requireAdmin } from "@/server/auth/guards";
import { hashPassword } from "@/server/auth/password";
import type { Ctx } from "@/server/auth/types";
import { recordActivity } from "./activity";

const createInput = z.object({ name: nameSchema, email: emailSchema, username: usernameSchema, password: passwordSchema });

/** Admin: create an Admin 2 (read-only auditor) account. */
export async function createAuditor(ctx: Ctx, input: unknown) {
  requireAdmin(ctx);
  const d = parse(createInput, input);
  const taken = await db.user.findFirst({ where: { OR: [{ email: d.email }, { username: d.username }] }, select: { email: true } });
  if (taken) throw conflict("That email or username is already in use.");
  const passwordHash = await hashPassword(d.password);
  const u = await db.user.create({
    data: { name: d.name, email: d.email, username: d.username, role: "AUDITOR", status: "ACTIVE", passwordHash },
    select: { id: true, name: true, email: true, username: true, createdAt: true },
  });
  await recordActivity(ctx, { type: "auditor.created", targetUserId: u.id, metadata: { username: u.username, email: u.email } });
  return u;
}

export async function listAuditors(ctx: Ctx) {
  requireAdmin(ctx);
  return db.user.findMany({
    where: { role: "AUDITOR" },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, email: true, username: true, status: true, createdAt: true, lastLoginAt: true },
  });
}
