import { z } from "zod";
import { db } from "@/lib/db";
import { notFound } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { pageQuery, skipTake, toPage } from "@/lib/pagination";
import { parse } from "@/lib/validation";
import { requireAdmin } from "@/server/auth/guards";
import type { Actor, Ctx } from "@/server/auth/types";
import { recordActivity } from "./activity";

const sendSchema = z.object({
  title: z.string().trim().min(2, "Enter a title").max(100, "Title is too long"),
  body: z.string().trim().min(1, "Write a message").max(1000, "Message is too long"),
  /** A user id, or empty / "all" to send to every user. */
  userId: z.string().max(64).optional(),
});

export async function sendNotification(ctx: Ctx, input: unknown) {
  const admin = requireAdmin(ctx);
  const d = parse(sendSchema, input);
  const toAll = !d.userId || d.userId === "all";
  if (!toAll) {
    const u = await db.user.findFirst({ where: { id: d.userId, role: "USER" }, select: { id: true } });
    if (!u) throw notFound("User");
  }
  const n = await db.notification.create({
    data: { title: d.title, body: d.body, userId: toAll ? null : d.userId, createdById: admin.userId },
    select: { id: true },
  });
  await audit(ctx, { action: "notification.send", entityType: "Notification", entityId: n.id, metadata: { to: toAll ? "all" : d.userId, title: d.title } });
  await recordActivity(ctx, { type: "notification.sent", targetUserId: toAll ? null : d.userId, metadata: { notificationId: n.id, to: toAll ? "all" : d.userId, title: d.title } });
  return n;
}

export async function listNotificationsAdmin(ctx: Ctx, raw: unknown) {
  requireAdmin(ctx);
  const q = parse(pageQuery, raw);
  const [items, total] = await Promise.all([
    db.notification.findMany({
      orderBy: { createdAt: "desc" },
      ...skipTake(q),
      select: {
        id: true, title: true, body: true, createdAt: true,
        user: { select: { id: true, name: true, username: true } },
        createdBy: { select: { name: true } },
        _count: { select: { reads: true } },
      },
    }),
    db.notification.count(),
  ]);
  return toPage(items, total, q);
}

/** Notifications a user can see: sent to them, or to everyone after they joined. */
async function visibleWhere(userId: string) {
  const u = await db.user.findUnique({ where: { id: userId }, select: { createdAt: true } });
  return { OR: [{ userId }, { userId: null, createdAt: { gte: u?.createdAt ?? new Date(0) } }] };
}

export async function listNotificationsForUser(actor: Actor, take = 30) {
  const where = await visibleWhere(actor.userId);
  const rows = await db.notification.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take,
    select: { id: true, title: true, body: true, createdAt: true, reads: { where: { userId: actor.userId }, select: { readAt: true } } },
  });
  return rows.map(({ reads, ...n }) => ({ ...n, read: reads.length > 0 }));
}

export async function unreadCount(userId: string): Promise<number> {
  const where = await visibleWhere(userId);
  return db.notification.count({ where: { AND: [where, { reads: { none: { userId } } }] } });
}

/** Mark the given notifications (or all) as read. Ids that are not visible to the user are ignored. */
export async function markRead(actor: Actor, input: { ids?: string[]; all?: boolean }) {
  const where = await visibleWhere(actor.userId);
  const rows = await db.notification.findMany({
    where: { AND: [where, { reads: { none: { userId: actor.userId } } }, input.all ? {} : { id: { in: (input.ids ?? []).slice(0, 100) } }] },
    select: { id: true },
    take: 500,
  });
  if (rows.length) {
    await db.notificationRead.createMany({ data: rows.map((r) => ({ notificationId: r.id, userId: actor.userId })), skipDuplicates: true });
  }
  return { marked: rows.length };
}
