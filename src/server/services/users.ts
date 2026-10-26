import { z } from "zod";
import { db } from "@/lib/db";
import { notFound } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { pageQuery, skipTake, toPage } from "@/lib/pagination";
import { parse } from "@/lib/validation";
import { requireAdmin } from "@/server/auth/guards";
import { revokeAllSessions } from "@/server/auth/session";
import type { Ctx } from "@/server/auth/types";

const listQuery = pageQuery.extend({ status: z.enum(["ACTIVE", "DISABLED"]).optional() });

export async function listUsers(ctx: Ctx, raw: unknown) {
  requireAdmin(ctx);
  const q = parse(listQuery, raw);
  const digits = q.q?.replace(/\D/g, "");
  const where = {
    role: "USER" as const,
    ...(q.status ? { status: q.status } : {}),
    ...(q.q
      ? {
          OR: [
            { name: { contains: q.q, mode: "insensitive" as const } },
            { username: { contains: q.q.toLowerCase() } },
            ...(digits ? [{ mobile: { contains: digits } }] : []),
          ],
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    db.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      ...skipTake(q),
      select: {
        id: true, name: true, username: true, mobile: true, status: true, createdAt: true, lastLoginAt: true,
        _count: { select: { transactions: true, assignments: true } },
      },
    }),
    db.user.count({ where }),
  ]);
  return toPage(items, total, q);
}

export async function getUserDetail(ctx: Ctx, id: string) {
  requireAdmin(ctx);
  const user = await db.user.findFirst({
    where: { id, role: "USER" },
    select: {
      id: true, name: true, username: true, mobile: true, status: true, createdAt: true, lastLoginAt: true, mobileVerifiedAt: true,
      assignments: { orderBy: { createdAt: "asc" }, select: { qr: { select: { id: true, label: true, amountPaise: true, active: true } } } },
      transactions: {
        orderBy: { createdAt: "desc" },
        take: 200,
        select: {
          id: true, txnId: true, status: true, rejectReason: true, createdAt: true, reviewedAt: true,
          qr: { select: { id: true, label: true } },
          reviewer: { select: { name: true, username: true } },
        },
      },
      notificationsIn: {
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { id: true, title: true, body: true, createdAt: true },
      },
    },
  });
  if (!user) throw notFound("User");
  return user;
}

export async function setUserStatus(ctx: Ctx, id: string, input: unknown) {
  requireAdmin(ctx);
  const { status } = parse(z.object({ status: z.enum(["ACTIVE", "DISABLED"]) }), input);
  const u = await db.user.findFirst({ where: { id, role: "USER" }, select: { id: true } });
  if (!u) throw notFound("User");
  await db.user.update({ where: { id }, data: { status } });
  if (status === "DISABLED") await revokeAllSessions(id);
  await audit(ctx, { action: status === "DISABLED" ? "user.disable" : "user.enable", entityType: "User", entityId: id });
  return { id, status };
}

export async function dashboardStats(ctx: Ctx) {
  requireAdmin(ctx);
  const [users, activeUsers, qrs, activeQrs, byStatus] = await Promise.all([
    db.user.count({ where: { role: "USER" } }),
    db.user.count({ where: { role: "USER", status: "ACTIVE" } }),
    db.qr.count(),
    db.qr.count({ where: { active: true } }),
    db.transaction.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  const t = { PENDING: 0, CONFIRMED: 0, REJECTED: 0 };
  for (const r of byStatus) t[r.status] = r._count._all;
  return { users, activeUsers, qrs, activeQrs, pending: t.PENDING, confirmed: t.CONFIRMED, rejected: t.REJECTED };
}
