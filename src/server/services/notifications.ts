import { createTransport, type Transporter } from "nodemailer";
import { db } from "@/lib/db";
import { env } from "@/lib/env";

let transport: Transporter | null | undefined;

function getTransport() {
  if (transport !== undefined) return transport;
  const e = env();
  if (!e.SMTP_HOST) return (transport = null);
  transport = createTransport({
    host: e.SMTP_HOST,
    port: e.SMTP_PORT ?? 587,
    secure: e.SMTP_SECURE === "true",
    auth: e.SMTP_USER ? { user: e.SMTP_USER, pass: e.SMTP_PASSWORD } : undefined,
  });
  return transport;
}

export function emailEnabled() {
  return !!env().SMTP_HOST;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function render(subject: string, body: string, link?: string) {
  const paras = body
    .split("\n\n")
    .map((p) => `<p style="margin:0 0 12px">${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
  const btn = link
    ? `<p><a href="${esc(link)}" style="display:inline-block;background:#0f766e;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Open</a></p><p style="color:#64748b;font-size:12px">${esc(link)}</p>`
    : "";
  return `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:auto;color:#0f172a"><h2 style="color:#0f766e">${esc(subject)}</h2>${paras}${btn}<hr style="border:0;border-top:1px solid #e2e8f0;margin:24px 0"><p style="color:#94a3b8;font-size:12px">YouPI PG</p></div>`;
}

export interface NotifyInput {
  userId?: string | null;
  to?: string | null;
  type: string;
  subject: string;
  body: string;
  link?: string;
  /** Also create an in-app notification (needs userId). */
  inApp?: boolean;
}

/**
 * Records every notification, sends email when SMTP is configured, and never throws:
 * an email failure must not break the business operation that triggered it.
 */
export async function notify(input: NotifyInput): Promise<{ emailStatus: "SENT" | "SKIPPED" | "FAILED" | "NONE" }> {
  let emailStatus: "SENT" | "SKIPPED" | "FAILED" | "NONE" = "NONE";
  try {
    if (input.inApp && input.userId) {
      await db.notification.create({
        data: {
          userId: input.userId,
          channel: "IN_APP",
          type: input.type,
          subject: input.subject,
          body: input.body,
          link: input.link,
          status: "SENT",
          sentAt: new Date(),
        },
      });
    }
    if (input.to) {
      const row = await db.notification.create({
        data: {
          userId: input.userId ?? null,
          channel: "EMAIL",
          type: input.type,
          toAddress: input.to,
          subject: input.subject,
          body: input.body,
          link: input.link,
          status: "QUEUED",
        },
      });
      const t = getTransport();
      if (!t) {
        await db.notification.update({ where: { id: row.id }, data: { status: "SKIPPED", error: "SMTP not configured" } });
        emailStatus = "SKIPPED";
      } else {
        try {
          await t.sendMail({
            from: env().MAIL_FROM,
            to: input.to,
            subject: input.subject,
            text: input.body + (input.link ? `\n\n${input.link}` : ""),
            html: render(input.subject, input.body, input.link),
          });
          await db.notification.update({ where: { id: row.id }, data: { status: "SENT", sentAt: new Date() } });
          emailStatus = "SENT";
        } catch (e) {
          await db.notification.update({
            where: { id: row.id },
            data: { status: "FAILED", error: (e instanceof Error ? e.message : "send failed").slice(0, 300) },
          });
          emailStatus = "FAILED";
        }
      }
    }
  } catch (e) {
    console.error("notify failed", e instanceof Error ? e.message : e);
  }
  return { emailStatus };
}

/** Notify every active client user of a business (e.g. payment received). */
export async function notifyBusinessUsers(businessId: string, n: Omit<NotifyInput, "userId" | "to">) {
  const members = await db.businessMembership.findMany({
    where: { businessId, user: { status: "ACTIVE" } },
    include: { user: { select: { id: true, email: true } } },
  });
  for (const m of members) await notify({ ...n, userId: m.user.id, to: m.user.email, inApp: true });
}

export async function notifyAdmins(n: Omit<NotifyInput, "userId" | "to">) {
  const admins = await db.user.findMany({ where: { role: "SUPER_ADMIN", status: "ACTIVE" }, select: { id: true, email: true } });
  for (const a of admins) await notify({ ...n, userId: a.id, to: a.email, inApp: true });
}
