import { db, type DbLike } from "./db";
import { redact } from "./redact";
import type { Ctx } from "@/server/auth/types";

const SENSITIVE = /pass|secret|token|otp|totp|key|signature|authorization|cookie/i;

export interface AuditInput {
  action: string; // e.g. "qr.create"
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

/** Append an audit record. Pass `tx` to make it part of the caller's transaction. */
export async function audit(ctx: Ctx, input: AuditInput, tx: DbLike = db) {
  await tx.auditLog.create({
    data: {
      actorId: ctx.actor?.userId ?? null,
      actorName: ctx.actor?.username ?? null,
      actorRole: ctx.actor?.role ?? (ctx.actor ? null : "SYSTEM"),
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      metadata: input.metadata ? (redact(input.metadata, SENSITIVE) as object) : undefined,
      ip: ctx.ip,
      userAgent: ctx.userAgent?.slice(0, 300) ?? null,
    },
  });
}
