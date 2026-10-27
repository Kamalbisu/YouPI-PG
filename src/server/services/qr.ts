import { z } from "zod";
import { db } from "@/lib/db";
import { AppError, notFound } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { parseRupees } from "@/lib/money";
import { parse } from "@/lib/validation";
import { requireAdmin } from "@/server/auth/guards";
import type { Actor, Ctx } from "@/server/auth/types";
import { saveImageAsset } from "./files";
import { recordActivity } from "./activity";

const labelSchema = z.string().trim().min(2, "Enter a label (at least 2 characters)").max(80, "Label is too long");
const boolish = (v: unknown) => v === true || v === "true" || v === "on" || v === "1";

function amountField(v: unknown): number | null {
  const r = parseRupees(v);
  if (r === "invalid") throw new AppError("VALIDATION", "Enter a valid amount, e.g. 500 or 499.50", { fields: { amount: "Enter a valid amount" } });
  return r;
}

/** Read the multipart/JSON body of the QR create and update routes into plain values. */
export async function readQrForm(req: Request): Promise<{ fields: Record<string, unknown>; file: File | null }> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("multipart/form-data")) {
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > 4 * 1024 * 1024) throw new AppError("VALIDATION", "Image must be 2 MB or smaller", { fields: { file: "Image must be 2 MB or smaller" } });
    const fd = await req.formData();
    const fields: Record<string, unknown> = {};
    let file: File | null = null;
    for (const [k, v] of fd.entries()) {
      if (typeof v === "string") fields[k] = v;
      else if (k === "file" && v.size > 0) file = v;
    }
    return { fields, file };
  }
  const text = await req.text();
  return { fields: text ? (JSON.parse(text) as Record<string, unknown>) : {}, file: null };
}

export async function createQr(ctx: Ctx, fields: Record<string, unknown>, file: unknown) {
  const admin = requireAdmin(ctx);
  const label = parse(labelSchema, fields.label);
  const amountPaise = amountField(fields.amount);
  const image = await saveImageAsset(file, admin.userId);
  const qr = await db.qr.create({
    data: { label, amountPaise, active: fields.active === undefined ? true : boolish(fields.active), forAll: boolish(fields.forAll), imageId: image.id, createdById: admin.userId },
    select: { id: true },
  });
  await audit(ctx, { action: "qr.create", entityType: "Qr", entityId: qr.id, metadata: { label } });
  await recordActivity(ctx, { type: "qr.created", metadata: { qrId: qr.id, label, forAll: boolish(fields.forAll) } });
  return qr;
}

export async function updateQr(ctx: Ctx, id: string, fields: Record<string, unknown>, file: unknown) {
  const admin = requireAdmin(ctx);
  const existing = await db.qr.findUnique({ where: { id }, select: { id: true, imageId: true } });
  if (!existing) throw notFound("QR");
  const data: { label?: string; amountPaise?: number | null; active?: boolean; forAll?: boolean; imageId?: string } = {};
  if (fields.label !== undefined) data.label = parse(labelSchema, fields.label);
  if ("amount" in fields) data.amountPaise = amountField(fields.amount);
  if (fields.active !== undefined) data.active = boolish(fields.active);
  if (fields.forAll !== undefined) data.forAll = boolish(fields.forAll);
  if (file) data.imageId = (await saveImageAsset(file, admin.userId)).id;
  await db.qr.update({ where: { id }, data });
  if (data.imageId) await db.fileAsset.deleteMany({ where: { id: existing.imageId, qrs: { none: {} } } });
  await audit(ctx, { action: "qr.update", entityType: "Qr", entityId: id, metadata: { ...data, imageId: data.imageId ? "replaced" : undefined } });
  await recordActivity(ctx, { type: "qr.updated", metadata: { qrId: id, ...data, imageId: data.imageId ? "replaced" : undefined } });
  return { id };
}

/** Deletes a QR that has no submissions; otherwise it is only deactivated so history is kept. */
export async function deleteQr(ctx: Ctx, id: string) {
  requireAdmin(ctx);
  const qr = await db.qr.findUnique({ where: { id }, select: { id: true, imageId: true, _count: { select: { transactions: true } } } });
  if (!qr) throw notFound("QR");
  if (qr._count.transactions > 0) {
    await db.qr.update({ where: { id }, data: { active: false } });
    await audit(ctx, { action: "qr.deactivate", entityType: "Qr", entityId: id, metadata: { reason: "has transactions" } });
    await recordActivity(ctx, { type: "qr.updated", metadata: { qrId: id, active: false, reason: "has transactions" } });
    return { deleted: false, deactivated: true };
  }
  await db.qr.delete({ where: { id } });
  await db.fileAsset.deleteMany({ where: { id: qr.imageId, qrs: { none: {} } } });
  await audit(ctx, { action: "qr.delete", entityType: "Qr", entityId: id });
  await recordActivity(ctx, { type: "qr.deleted", metadata: { qrId: id } });
  return { deleted: true, deactivated: false };
}

async function resolveUser(input: { userId?: string; username?: string }) {
  const where = input.userId ? { id: input.userId } : input.username ? { username: input.username.trim().toLowerCase().replace(/^@/, "") } : null;
  if (!where) throw new AppError("VALIDATION", "Choose a user");
  const user = await db.user.findFirst({ where: { ...where, role: "USER" }, select: { id: true, username: true } });
  if (!user) throw notFound("User");
  return user;
}

export async function assignQr(ctx: Ctx, qrId: string, input: { userId?: string; username?: string }) {
  requireAdmin(ctx);
  const [qr, user] = await Promise.all([db.qr.findUnique({ where: { id: qrId }, select: { id: true } }), resolveUser(input)]);
  if (!qr) throw notFound("QR");
  await db.qrAssignment.upsert({ where: { qrId_userId: { qrId, userId: user.id } }, create: { qrId, userId: user.id }, update: {} });
  await audit(ctx, { action: "qr.assign", entityType: "Qr", entityId: qrId, metadata: { userId: user.id, username: user.username } });
  await recordActivity(ctx, { type: "qr.assigned", targetUserId: user.id, metadata: { qrId, username: user.username } });
  return { qrId, userId: user.id };
}

export async function unassignQr(ctx: Ctx, qrId: string, input: { userId?: string; username?: string }) {
  requireAdmin(ctx);
  const user = await resolveUser(input);
  await db.qrAssignment.deleteMany({ where: { qrId, userId: user.id } });
  await audit(ctx, { action: "qr.unassign", entityType: "Qr", entityId: qrId, metadata: { userId: user.id, username: user.username } });
  await recordActivity(ctx, { type: "qr.unassigned", targetUserId: user.id, metadata: { qrId, username: user.username } });
  return { qrId, userId: user.id };
}

export const AssignInput = z.object({ userId: z.string().max(64).optional(), username: z.string().max(40).optional() });

export async function listQrsAdmin() {
  return db.qr.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true, label: true, amountPaise: true, active: true, forAll: true, imageId: true, createdAt: true,
      _count: { select: { transactions: true } },
      assignments: { select: { user: { select: { id: true, name: true, username: true } } }, orderBy: { createdAt: "asc" }, take: 200 },
    },
  });
}

/** Where-clause for QRs a given user may see and pay to. */
export const visibleToUser = (userId: string) => ({ active: true, OR: [{ forAll: true }, { assignments: { some: { userId } } }] });

/** The user dashboard: their QRs, each with that user's own submissions. */
export async function listQrsForUser(actor: Actor) {
  return db.qr.findMany({
    where: visibleToUser(actor.userId),
    orderBy: { createdAt: "asc" },
    select: {
      id: true, label: true, amountPaise: true, imageId: true,
      transactions: {
        where: { userId: actor.userId },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { id: true, txnId: true, status: true, rejectReason: true, createdAt: true, reviewedAt: true },
      },
    },
  });
}

/** Image bytes if (and only if) this actor may see the QR. */
export async function getQrImageFor(actor: Actor, id: string) {
  if (!id || id.length > 64) throw notFound("QR");
  const where = actor.role === "ADMIN" ? { id } : { id, ...visibleToUser(actor.userId) };
  const qr = await db.qr.findFirst({ where, select: { image: { select: { contentType: true, sha256: true, data: true } } } });
  if (!qr) throw notFound("QR");
  return qr.image;
}
