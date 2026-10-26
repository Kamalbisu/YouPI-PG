import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { pageQuery, skipTake, toPage } from "@/lib/pagination";
import { parse } from "@/lib/validation";
import { requireAdmin } from "@/server/auth/guards";
import type { Ctx } from "@/server/auth/types";

const dateParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .optional()
  .catch(undefined);
const text = z.string().trim().max(100).optional().catch(undefined);

export const auditFilter = z.object({
  action: text,
  entityType: text,
  clientId: text,
  actor: text,
  from: dateParam,
  to: dateParam,
});

const listInput = pageQuery.merge(auditFilter);

function buildWhere(f: z.infer<typeof auditFilter>, q?: string): Prisma.AuditLogWhereInput {
  const and: Prisma.AuditLogWhereInput[] = [];
  if (f.action) and.push({ action: { contains: f.action, mode: "insensitive" } });
  if (f.entityType) and.push({ entityType: f.entityType });
  if (f.clientId) and.push({ clientId: f.clientId });
  if (f.actor) and.push({ OR: [{ actorId: f.actor }, { actorEmail: { contains: f.actor, mode: "insensitive" } }] });
  // Dates are interpreted as UTC calendar days; "to" is inclusive.
  if (f.from) and.push({ createdAt: { gte: new Date(`${f.from}T00:00:00.000Z`) } });
  if (f.to) and.push({ createdAt: { lt: new Date(new Date(`${f.to}T00:00:00.000Z`).getTime() + 24 * 3600 * 1000) } });
  if (q) {
    and.push({ OR: [{ action: { contains: q, mode: "insensitive" } }, { actorEmail: { contains: q, mode: "insensitive" } }, { entityId: q }] });
  }
  return and.length ? { AND: and } : {};
}

export async function listAuditLogs(ctx: Ctx, raw: unknown) {
  requireAdmin(ctx);
  const q = parse(listInput, raw);
  const where = buildWhere(q, q.q);
  const [items, total] = await Promise.all([
    db.auditLog.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], ...skipTake(q) }),
    db.auditLog.count({ where }),
  ]);
  return toPage(items, total, q);
}

/** Distinct values used to populate filter dropdowns. */
export async function auditFilterOptions(ctx: Ctx) {
  requireAdmin(ctx);
  const [actions, entityTypes] = await Promise.all([
    db.auditLog.findMany({ distinct: ["action"], select: { action: true }, orderBy: { action: "asc" }, take: 200 }),
    db.auditLog.findMany({ where: { entityType: { not: null } }, distinct: ["entityType"], select: { entityType: true }, orderBy: { entityType: "asc" }, take: 100 }),
  ]);
  return { actions: actions.map((a) => a.action), entityTypes: entityTypes.map((e) => e.entityType as string) };
}

/**
 * Spreadsheet programs run cells that start with = + - @ (and tab or carriage return) as formulas.
 * Prefix those with a single quote so imported data stays inert, then quote per RFC 4180.
 */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : value instanceof Date ? value.toISOString() : typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || s.startsWith("'") ? `"${s.replace(/"/g, '""')}"` : s;
}

export const AUDIT_CSV_HEADER = ["time", "actor_email", "actor_role", "action", "entity_type", "entity_id", "client_id", "ip", "metadata"];
export const AUDIT_EXPORT_MAX_ROWS = 50_000;

/** Streams matching rows in keyset-paged batches so memory stays flat for large exports. */
export function auditCsvStream(ctx: Ctx, raw: unknown): ReadableStream<Uint8Array> {
  requireAdmin(ctx);
  const f = parse(auditFilter, raw);
  const where = buildWhere(f);
  const enc = new TextEncoder();
  let cursor: string | undefined;
  let sent = 0;
  let started = false;
  const BATCH = 500;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!started) {
          started = true;
          controller.enqueue(enc.encode(`${AUDIT_CSV_HEADER.join(",")}\r\n`));
          return;
        }
        if (sent >= AUDIT_EXPORT_MAX_ROWS) return controller.close();
        const rows = await db.auditLog.findMany({
          where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: BATCH,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        if (rows.length === 0) return controller.close();
        cursor = rows[rows.length - 1].id;
        sent += rows.length;
        const chunk = rows
          .map((r) => [r.createdAt, r.actorEmail, r.actorRole, r.action, r.entityType, r.entityId, r.clientId, r.ip, r.metadata].map(csvCell).join(","))
          .join("\r\n");
        controller.enqueue(enc.encode(`${chunk}\r\n`));
        if (rows.length < BATCH) controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });
}
