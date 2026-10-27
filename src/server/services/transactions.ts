import { z } from "zod";
import { db } from "@/lib/db";
import { AppError, notFound } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { enforceRateLimit } from "@/lib/rate-limit";
import { pageQuery, skipTake, toPage } from "@/lib/pagination";
import { idSchema, parse, txnIdSchema } from "@/lib/validation";
import { requireAdmin, requireUser } from "@/server/auth/guards";
import type { Ctx } from "@/server/auth/types";
import { visibleToUser } from "./qr";
import { recordActivity } from "./activity";

export async function submitTransaction(ctx: Ctx, input: unknown) {
  const actor = requireUser(ctx);
  const { qrId, txnId } = parse(z.object({ qrId: idSchema, txnId: txnIdSchema }), input);
  await enforceRateLimit(`txn:user:${actor.userId}`, 10, 600, "Too many submissions. Please wait a few minutes.");
  await enforceRateLimit(`txn:ip:${ctx.ip ?? "unknown"}`, 60, 600, "Too many submissions. Please wait a few minutes.");

  const qr = await db.qr.findFirst({ where: { id: qrId, ...visibleToUser(actor.userId) }, select: { id: true } });
  if (!qr) throw notFound("QR");
  try {
    const t = await db.transaction.create({
      data: { userId: actor.userId, qrId, txnId },
      select: { id: true, txnId: true, status: true, createdAt: true },
    });
    await audit(ctx, { action: "transaction.submit", entityType: "Transaction", entityId: t.id, metadata: { qrId, txnId } });
    await recordActivity(ctx, { type: "txn.manual.submitted", targetUserId: actor.userId, transactionId: t.id, paymentRef: txnId, toStatus: "PENDING", metadata: { qrId, txnId } });
    return t;
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") {
      throw new AppError("CONFLICT", "This transaction ID has already been submitted.", { fields: { txnId: "Already submitted" } });
    }
    throw e;
  }
}

const listQuery = pageQuery.extend({
  status: z.enum(["PENDING", "CONFIRMED", "REJECTED"]).optional(),
  userId: z.string().max(64).optional(),
});

export async function listTransactionsAdmin(ctx: Ctx, raw: unknown) {
  requireAdmin(ctx);
  const q = parse(listQuery, raw);
  const txn = q.q?.toUpperCase().replace(/\s+/g, "");
  const where = {
    ...(q.status ? { status: q.status } : {}),
    ...(q.userId ? { userId: q.userId } : {}),
    ...(q.q
      ? {
          OR: [
            ...(txn ? [{ txnId: { contains: txn } }] : []),
            { user: { username: { contains: q.q.toLowerCase() } } },
            { user: { name: { contains: q.q, mode: "insensitive" as const } } },
            { user: { mobile: { contains: q.q.replace(/\D/g, "") || "x" } } },
          ],
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    db.transaction.findMany({
      where,
      orderBy: { createdAt: "desc" },
      ...skipTake(q),
      select: {
        id: true, txnId: true, status: true, rejectReason: true, createdAt: true, reviewedAt: true,
        user: { select: { id: true, name: true, username: true, mobile: true } },
        qr: { select: { id: true, label: true } },
        reviewer: { select: { name: true, username: true } },
      },
    }),
    db.transaction.count({ where }),
  ]);
  return toPage(items, total, q);
}

async function review(ctx: Ctx, id: string, status: "CONFIRMED" | "REJECTED", reason?: string) {
  const admin = requireAdmin(ctx);
  const existing = await db.transaction.findUnique({ where: { id }, select: { id: true, txnId: true, userId: true, status: true } });
  if (!existing) throw notFound("Transaction");
  // Only a pending submission can be decided, and only once, even if two admins click together.
  const res = await db.transaction.updateMany({
    where: { id, status: "PENDING" },
    data: { status, rejectReason: status === "REJECTED" ? reason : null, reviewedById: admin.userId, reviewedAt: new Date() },
  });
  if (res.count !== 1) throw new AppError("CONFLICT", `This transaction was already ${existing.status.toLowerCase()}.`);
  await audit(ctx, {
    action: status === "CONFIRMED" ? "transaction.confirm" : "transaction.reject",
    entityType: "Transaction",
    entityId: id,
    metadata: { txnId: existing.txnId, userId: existing.userId, ...(reason ? { reason } : {}) },
  });
  await recordActivity(ctx, {
    type: status === "CONFIRMED" ? "txn.manual.confirmed" : "txn.manual.rejected",
    targetUserId: existing.userId,
    transactionId: id,
    paymentRef: existing.txnId,
    fromStatus: "PENDING",
    toStatus: status,
    metadata: { txnId: existing.txnId, ...(reason ? { reason } : {}) },
  });
  return { id, status };
}

export const confirmTransaction = (ctx: Ctx, id: string) => review(ctx, id, "CONFIRMED");

export async function rejectTransaction(ctx: Ctx, id: string, input: unknown) {
  const { reason } = parse(z.object({ reason: z.string().trim().min(3, "Give a short reason (at least 3 characters)").max(200, "Reason is too long") }), input);
  return review(ctx, id, "REJECTED", reason);
}
