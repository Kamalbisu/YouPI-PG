import { db, type DbLike } from "./db";
import type { Ctx } from "@/server/auth/types";

const SENSITIVE = /pass|secret|token|otp|totp|key|signature|authorization|cookie/i;

function redact(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined) return v;
  if (depth > 4) return "[truncated]";
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redact(x, depth + 1));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SENSITIVE.test(k) ? "[redacted]" : redact(val, depth + 1);
    }
    return out;
  }
  if (typeof v === "string" && v.length > 500) return v.slice(0, 500) + "…";
  return v;
}

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
      metadata: input.metadata ? (redact(input.metadata) as object) : undefined,
      ip: ctx.ip,
      userAgent: ctx.userAgent?.slice(0, 300) ?? null,
    },
  });
}
