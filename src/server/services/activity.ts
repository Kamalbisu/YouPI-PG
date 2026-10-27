import { z } from "zod";
import { db, type DbLike } from "@/lib/db";
import { redact } from "@/lib/redact";
import { skipTake, toPage, pageQuery } from "@/lib/pagination";
import { parse } from "@/lib/validation";
import { requireAuditor } from "@/server/auth/guards";
import type { Ctx } from "@/server/auth/types";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Append-only activity trace (what Admin 2 reads).
 *
 * `recordActivity` is the ONLY writer. There is no update or delete function anywhere in the code,
 * and a database trigger rejects UPDATE/DELETE on the table as well.
 */

export type ActorType = "USER" | "ADMIN" | "AUDITOR" | "SYSTEM" | "GATEWAY";

export const ACTIVITY_TYPES = [
  "auth.signup.started",
  "auth.signup.verified",
  "auth.login.success",
  "auth.login.failed",
  "auth.otp.sent",
  "auth.otp.verified",
  "auth.otp.failed",
  "payment.initiated",
  "payment.redirected",
  "payment.initiate.failed",
  "payment.callback.received",
  "payment.callback.rejected",
  "payment.status.changed",
  "payment.reconciled",
  "txn.manual.submitted",
  "txn.manual.confirmed",
  "txn.manual.rejected",
  "refund.requested",
  "refund.queued",
  "refund.processed",
  "refund.failed",
  "refund.webhook.received",
  "refund.webhook.rejected",
  "notification.sent",
  "qr.created",
  "qr.updated",
  "qr.deleted",
  "qr.assigned",
  "qr.unassigned",
  "auditor.created",
] as const;

export interface ActivityInput {
  type: string;
  /** Defaults to the signed-in actor's role, or SYSTEM when nobody is signed in. */
  actor?: { type: ActorType; id?: string | null; name?: string | null };
  targetUserId?: string | null;
  paymentId?: string | null;
  refundId?: string | null;
  transactionId?: string | null;
  paymentRef?: string | null;
  fromStatus?: string | null;
  toStatus?: string | null;
  metadata?: Record<string, unknown>;
}

/** "+919876543210" -> "+91******3210": enough to recognise, not enough to misuse. */
export function maskPhone(p: string): string {
  return p.length <= 6 ? "******" : `${p.slice(0, 3)}${"*".repeat(p.length - 7)}${p.slice(-4)}`;
}

/** "asha@example.com" -> "a***@example.com". */
export function maskEmail(e: string): string {
  const [local = "", domain = ""] = e.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

function actorOf(ctx: Ctx, input: ActivityInput) {
  if (input.actor) return { actorType: input.actor.type, actorId: input.actor.id ?? null, actorName: input.actor.name ?? null };
  if (ctx.actor) return { actorType: ctx.actor.role as ActorType, actorId: ctx.actor.userId, actorName: ctx.actor.username };
  return { actorType: "SYSTEM" as ActorType, actorId: null, actorName: null };
}

/** Append one event. Pass `tx` to make it part of the caller's transaction. */
export async function recordActivity(ctx: Ctx, input: ActivityInput, tx: DbLike = db) {
  const a = actorOf(ctx, input);
  await tx.activityEvent.create({
    data: {
      type: input.type,
      ...a,
      targetUserId: input.targetUserId ?? null,
      paymentId: input.paymentId ?? null,
      refundId: input.refundId ?? null,
      transactionId: input.transactionId ?? null,
      paymentRef: input.paymentRef ?? null,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      ip: ctx.ip,
      userAgent: ctx.userAgent?.slice(0, 300) ?? null,
      metadata: input.metadata ? (redact(input.metadata) as Prisma.InputJsonValue) : undefined,
    },
  });
}

// ---------- read side (Admin 2) ----------

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const activityQuery = pageQuery.extend({
  userId: z.string().max(64).optional(),
  paymentId: z.string().max(64).optional(),
  actorType: z.enum(["USER", "ADMIN", "AUDITOR", "SYSTEM", "GATEWAY"]).optional(),
  actorId: z.string().max(64).optional(),
  type: z.string().max(60).optional(),
  from: dateStr.optional(),
  to: dateStr.optional(),
});

function whereFrom(q: z.infer<typeof activityQuery>): Prisma.ActivityEventWhereInput {
  const created: Prisma.DateTimeFilter = {};
  if (q.from) created.gte = new Date(`${q.from}T00:00:00.000Z`);
  if (q.to) created.lte = new Date(`${q.to}T23:59:59.999Z`);
  return {
    ...(q.userId ? { targetUserId: q.userId } : {}),
    ...(q.paymentId ? { paymentId: q.paymentId } : {}),
    ...(q.actorType ? { actorType: q.actorType } : {}),
    ...(q.actorId ? { actorId: q.actorId } : {}),
    // "payment" matches every payment.* event, "payment.callback.received" matches exactly one
    ...(q.type ? { type: q.type.includes(".") ? q.type : { startsWith: `${q.type}.` } } : {}),
    ...(q.from || q.to ? { createdAt: created } : {}),
    ...(q.q
      ? {
          OR: [
            { paymentRef: { contains: q.q.toUpperCase().replace(/\s+/g, "") } },
            { actorName: { contains: q.q.toLowerCase() } },
            { type: { contains: q.q.toLowerCase() } },
            { ip: { contains: q.q } },
          ],
        }
      : {}),
  };
}

const eventSelect = {
  id: true, createdAt: true, type: true, actorType: true, actorId: true, actorName: true, targetUserId: true,
  paymentId: true, refundId: true, transactionId: true, paymentRef: true, fromStatus: true, toStatus: true,
  ip: true, userAgent: true, metadata: true,
} satisfies Prisma.ActivityEventSelect;

/** Resolve user ids to display names for a page of events. */
async function withUserNames<T extends { targetUserId: string | null }>(items: T[]) {
  const ids = [...new Set(items.map((i) => i.targetUserId).filter((x): x is string => !!x))];
  const users = ids.length ? await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, username: true } }) : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  return items.map((i) => ({ ...i, targetUser: i.targetUserId ? (byId.get(i.targetUserId) ?? null) : null }));
}

export async function listActivity(ctx: Ctx, raw: unknown) {
  requireAuditor(ctx);
  const q = parse(activityQuery, raw);
  const where = whereFrom(q);
  const [items, total] = await Promise.all([
    db.activityEvent.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], ...skipTake(q), select: eventSelect }),
    db.activityEvent.count({ where }),
  ]);
  return toPage(await withUserNames(items), total, q);
}

const EXPORT_LIMIT = 10_000;

const csvCell = (v: unknown): string => {
  let s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  // Stop spreadsheet formula injection from user-controlled text.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

export async function exportActivityCsv(ctx: Ctx, raw: unknown): Promise<string> {
  requireAuditor(ctx);
  const q = parse(activityQuery, raw);
  const rows = await db.activityEvent.findMany({
    where: whereFrom(q),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: EXPORT_LIMIT,
    select: eventSelect,
  });
  const head = ["time", "event", "actor_type", "actor", "target_user_id", "payment_id", "payment_ref", "refund_id", "from_status", "to_status", "ip", "user_agent", "details"];
  const lines = [head.join(",")];
  for (const r of rows) {
    lines.push(
      [r.createdAt.toISOString(), r.type, r.actorType, r.actorName, r.targetUserId, r.paymentId, r.paymentRef, r.refundId, r.fromStatus, r.toStatus, r.ip, r.userAgent, r.metadata]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}

/** Everything that happened to one payment, oldest first (includes its refunds). */
export async function paymentTimeline(ctx: Ctx, paymentId: string) {
  requireAuditor(ctx);
  const payment = await db.payment.findUnique({
    where: { id: paymentId },
    include: {
      user: { select: { id: true, name: true, username: true, mobile: true } },
      refunds: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!payment) return null;
  const events = await db.activityEvent.findMany({
    where: { OR: [{ paymentId }, { paymentRef: payment.txnId }] },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 500,
    select: eventSelect,
  });
  const { gatewayResponse: _g, ...safe } = payment;
  void _g;
  return { payment: safe, events };
}

/** Everything that happened around one user, newest first, paginated. */
export async function userTimeline(ctx: Ctx, userId: string, raw: unknown) {
  requireAuditor(ctx);
  const q = parse(pageQuery, raw);
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, username: true, email: true, mobile: true, role: true, status: true } });
  if (!user) return null;
  const where: Prisma.ActivityEventWhereInput = { OR: [{ targetUserId: userId }, { actorId: userId }] };
  const [items, total] = await Promise.all([
    db.activityEvent.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], ...skipTake(q), select: eventSelect }),
    db.activityEvent.count({ where }),
  ]);
  return { user, events: toPage(items, total, q) };
}
