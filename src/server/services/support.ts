import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { badRequest, notFound } from "@/lib/errors";
import { randomCode, withUniqueCode } from "@/lib/ids";
import { pageQuery, skipTake, toPage } from "@/lib/pagination";
import { idSchema, parse } from "@/lib/validation";
import { assertBusinessAccess, requireActor, requireAdmin, requireClient } from "@/server/auth/guards";
import type { Actor, Ctx } from "@/server/auth/types";
import { notify, notifyAdmins } from "./notifications";
import { env } from "@/lib/env";

const statusEnum = z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]);
const priorityEnum = z.enum(["LOW", "NORMAL", "HIGH"]);
const bodySchema = z.string().trim().min(3, "Write at least 3 characters").max(5000, "Keep it under 5000 characters");

export const createTicketInput = z.object({
  subject: z.string().trim().min(3, "Write at least 3 characters").max(150, "Keep it under 150 characters"),
  body: bodySchema,
  priority: priorityEnum.default("NORMAL"),
  businessId: z.union([idSchema, z.literal("").transform(() => undefined)]).optional(),
});

const listInput = pageQuery.extend({
  status: statusEnum.optional().catch(undefined),
  priority: priorityEnum.optional().catch(undefined),
  clientId: idSchema.optional().catch(undefined),
});

const TICKET_LIST = {
  id: true, ticketCode: true, subject: true, status: true, priority: true, createdAt: true, updatedAt: true, clientId: true, businessId: true,
  client: { select: { id: true, name: true, clientCode: true } },
  business: { select: { id: true, name: true } },
  _count: { select: { messages: true } },
} satisfies Prisma.SupportTicketSelect;

/**
 * Which tickets a client user may see. Owners see the whole account; a manager sees only
 * tickets they opened or that concern a business they belong to.
 */
function clientScope(a: Actor & { clientId: string }): Prisma.SupportTicketWhereInput {
  if (a.isOwner) return { clientId: a.clientId };
  return { clientId: a.clientId, OR: [{ createdById: a.userId }, { businessId: { in: a.businessIds } }] };
}

function listWhere(q: z.infer<typeof listInput>, base: Prisma.SupportTicketWhereInput): Prisma.SupportTicketWhereInput {
  return {
    AND: [
      base,
      ...(q.status ? [{ status: q.status }] : []),
      ...(q.priority ? [{ priority: q.priority }] : []),
      ...(q.clientId ? [{ clientId: q.clientId }] : []),
      ...(q.q ? [{ OR: [{ subject: { contains: q.q, mode: "insensitive" as const } }, { ticketCode: { contains: q.q, mode: "insensitive" as const } }] }] : []),
    ],
  };
}

const appLink = (path: string) => `${env().APP_URL}${path}`;

// ---------------------------------------------------------------------------
// Client side

export async function createTicket(ctx: Ctx, raw: unknown) {
  const a = requireClient(ctx, "support.use");
  const input = parse(createTicketInput, raw);
  // A ticket may only reference a business the caller belongs to (404 otherwise).
  if (input.businessId) await assertBusinessAccess(ctx, input.businessId);
  const ticket = await withUniqueCode(
    () => randomCode("TK"),
    (ticketCode) =>
      db.$transaction(async (tx) => {
        const t = await tx.supportTicket.create({
          data: {
            ticketCode, clientId: a.clientId, businessId: input.businessId ?? null, createdById: a.userId,
            subject: input.subject, priority: input.priority,
            messages: { create: { authorId: a.userId, body: input.body } },
          },
        });
        await audit(ctx, { action: "support.create", entityType: "SupportTicket", entityId: t.id, clientId: a.clientId, metadata: { ticketCode, priority: t.priority } }, tx);
        return t;
      }),
  );
  await notifyAdmins({ type: "support.new", subject: `New support ticket ${ticket.ticketCode}`, body: `${ticket.subject}`, link: appLink(`/admin/support/${ticket.id}`) });
  return ticket;
}

export async function listMyTickets(ctx: Ctx, raw: unknown) {
  const a = requireClient(ctx, "support.use");
  const q = parse(listInput, raw);
  const where = listWhere({ ...q, clientId: undefined }, clientScope(a));
  const [items, total] = await Promise.all([
    db.supportTicket.findMany({ where, orderBy: { updatedAt: "desc" }, ...skipTake(q), select: TICKET_LIST }),
    db.supportTicket.count({ where }),
  ]);
  return toPage(items, total, q);
}

const MESSAGE_INCLUDE = {
  messages: { orderBy: { createdAt: "asc" as const }, include: { author: { select: { id: true, name: true, role: true } } } },
  client: { select: { id: true, name: true, clientCode: true } },
  business: { select: { id: true, name: true, businessCode: true } },
  creator: { select: { id: true, name: true, email: true } },
};

/** Admin: any ticket. Client: only tickets within their scope; anything else is a 404. */
export async function getTicket(ctx: Ctx, id: string) {
  const a = requireActor(ctx);
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) throw notFound("Ticket");
  const where: Prisma.SupportTicketWhereInput =
    a.role === "SUPER_ADMIN" ? { id: parsed.data } : { AND: [{ id: parsed.data }, clientScope(requireClient(ctx, "support.use"))] };
  const t = await db.supportTicket.findFirst({ where, include: MESSAGE_INCLUDE });
  if (!t) throw notFound("Ticket");
  return t;
}

/** Reply by whoever is allowed to see the ticket. Notifies the other side. */
export async function replyToTicket(ctx: Ctx, id: string, raw: unknown) {
  const a = requireActor(ctx);
  const { body } = parse(z.object({ body: bodySchema }), raw);
  const ticket = await getTicket(ctx, id); // enforces scope: 404 for someone else's ticket
  const isAdmin = a.role === "SUPER_ADMIN";
  if (ticket.status === "CLOSED") throw badRequest("This ticket is closed. Open a new ticket if you need more help.");

  const nextStatus = isAdmin ? (ticket.status === "OPEN" ? "IN_PROGRESS" : ticket.status) : ticket.status === "RESOLVED" ? "OPEN" : ticket.status;
  const message = await db.$transaction(async (tx) => {
    const m = await tx.ticketMessage.create({ data: { ticketId: ticket.id, authorId: a.userId, body } });
    await tx.supportTicket.update({ where: { id: ticket.id }, data: { status: nextStatus } });
    await audit(ctx, { action: "support.reply", entityType: "SupportTicket", entityId: ticket.id, clientId: ticket.clientId, metadata: { ticketCode: ticket.ticketCode, by: isAdmin ? "admin" : "client" } }, tx);
    return m;
  });

  if (isAdmin) {
    await notify({
      userId: ticket.creator.id, to: ticket.creator.email, type: "support.reply", inApp: true,
      subject: `Reply on ticket ${ticket.ticketCode}`, body: `Support replied to "${ticket.subject}". Open the ticket to read it.`,
      link: appLink(`/client/support/${ticket.id}`),
    });
  } else {
    await notifyAdmins({ type: "support.reply", subject: `Client reply on ${ticket.ticketCode}`, body: `${ticket.client.name} replied to "${ticket.subject}".`, link: appLink(`/admin/support/${ticket.id}`) });
  }
  return message;
}

/** A client may close their own resolved or open ticket. */
export async function closeMyTicket(ctx: Ctx, id: string) {
  const a = requireClient(ctx, "support.use");
  const ticket = await getTicket(ctx, id);
  if (ticket.status === "CLOSED") return { status: "CLOSED" as const };
  await db.$transaction(async (tx) => {
    await tx.supportTicket.update({ where: { id: ticket.id }, data: { status: "CLOSED" } });
    await audit(ctx, { action: "support.close", entityType: "SupportTicket", entityId: ticket.id, clientId: a.clientId, metadata: { ticketCode: ticket.ticketCode } }, tx);
  });
  return { status: "CLOSED" as const };
}

// ---------------------------------------------------------------------------
// Admin side

export async function listAllTickets(ctx: Ctx, raw: unknown) {
  requireAdmin(ctx);
  const q = parse(listInput, raw);
  const where = listWhere(q, {});
  const [items, total] = await Promise.all([
    db.supportTicket.findMany({ where, orderBy: [{ updatedAt: "desc" }], ...skipTake(q), select: TICKET_LIST }),
    db.supportTicket.count({ where }),
  ]);
  return toPage(items, total, q);
}

async function adminUpdate(ctx: Ctx, id: string, data: Prisma.SupportTicketUpdateInput, action: string, meta: (t: { status: string; priority: string }) => Record<string, unknown>) {
  requireAdmin(ctx);
  const parsed = idSchema.safeParse(id);
  const t = parsed.success ? await db.supportTicket.findUnique({ where: { id: parsed.data }, include: { creator: { select: { id: true, email: true } } } }) : null;
  if (!t) throw notFound("Ticket");
  const updated = await db.$transaction(async (tx) => {
    const u = await tx.supportTicket.update({ where: { id: t.id }, data });
    await audit(ctx, { action, entityType: "SupportTicket", entityId: t.id, clientId: t.clientId, metadata: { ticketCode: t.ticketCode, ...meta(t) } }, tx);
    return u;
  });
  return { before: t, after: updated };
}

export async function setTicketStatus(ctx: Ctx, id: string, raw: unknown) {
  const { status } = parse(z.object({ status: statusEnum }), raw);
  const { before, after } = await adminUpdate(ctx, id, { status }, "support.status", (t) => ({ from: t.status, to: status }));
  if (before.status !== status) {
    await notify({
      userId: before.creator.id, to: before.creator.email, type: "support.status", inApp: true,
      subject: `Ticket ${before.ticketCode} is now ${status.toLowerCase().replace("_", " ")}`, body: `The status of "${before.subject}" changed to ${status.toLowerCase().replace("_", " ")}.`,
      link: appLink(`/client/support/${before.id}`),
    });
  }
  return after;
}

export async function setTicketPriority(ctx: Ctx, id: string, raw: unknown) {
  const { priority } = parse(z.object({ priority: priorityEnum }), raw);
  const { after } = await adminUpdate(ctx, id, { priority }, "support.priority", (t) => ({ from: t.priority, to: priority }));
  return after;
}
