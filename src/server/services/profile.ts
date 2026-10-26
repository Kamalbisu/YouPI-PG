import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { nameSchema, optionalPhone, parse } from "@/lib/validation";
import { requireActor } from "@/server/auth/guards";
import type { Ctx } from "@/server/auth/types";
import { recentLogins } from "./auth";

const updateInput = z.object({ name: nameSchema, phone: optionalPhone });

/** The signed-in user's own profile. Never includes the password hash or TOTP secret. */
export async function getProfile(ctx: Ctx) {
  const a = requireActor(ctx);
  const user = await db.user.findUniqueOrThrow({
    where: { id: a.userId },
    select: { id: true, name: true, email: true, phone: true, role: true, totpEnabled: true, lastLoginAt: true, createdAt: true, passwordChangedAt: true },
  });
  const logins = await recentLogins(ctx, 10);
  return { user, logins, isOwner: a.isOwner };
}

export async function updateProfile(ctx: Ctx, raw: unknown) {
  const a = requireActor(ctx);
  const input = parse(updateInput, raw);
  return db.$transaction(async (tx) => {
    const u = await tx.user.update({
      where: { id: a.userId },
      data: { name: input.name, phone: input.phone ?? null },
      select: { id: true, name: true, email: true, phone: true },
    });
    await audit(ctx, { action: "profile.update", entityType: "User", entityId: a.userId, metadata: { name: u.name } }, tx);
    return u;
  });
}
