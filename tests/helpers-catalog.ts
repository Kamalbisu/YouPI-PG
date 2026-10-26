import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { randomToken } from "@/lib/ids";
import { cookieName, actorFromToken, createSession } from "@/server/auth/session";
import { hashPassword } from "@/server/auth/password";
import type { Ctx } from "@/server/auth/types";
import { makeAdmin, PASSWORD } from "./helpers";

let seq = 0;
const next = () => ++seq;

export interface Tenant {
  client: { id: string };
  user: { id: string; email: string };
  business: { id: string; name: string };
  ctx: Ctx;
  cookie: string;
}

export async function ctxFromUser(userId: string, ip = "198.51.100.7"): Promise<{ ctx: Ctx; cookie: string }> {
  const { token } = await createSession(userId, { ip, userAgent: "vitest" });
  const actor = await actorFromToken(token);
  return { ctx: { actor, ip, userAgent: "vitest" }, cookie: `${cookieName()}=${token}` };
}

/** A client account with one active business and one OWNER user, signed in through a real session. */
export async function makeTenant(opts: { permissions?: string[]; businessStatus?: "ACTIVE" | "SUSPENDED"; tag?: string } = {}): Promise<Tenant> {
  const n = next();
  const tag = opts.tag ?? `t${n}`;
  const permissions = opts.permissions ?? ["products.manage", "offers.manage", "qr.manage", "payments.view"];
  const client = await db.client.create({
    data: { clientCode: `CL-CAT${String(n).padStart(5, "0")}`, name: `Client ${tag}`, contactName: "Owner", email: `owner-${tag}@shop.test`, permissions, maxBusinesses: 5 },
  });
  const user = await db.user.create({
    data: { email: `owner-${tag}@shop.test`, name: `Owner ${tag}`, role: "CLIENT", status: "ACTIVE", clientId: client.id, passwordHash: await hashPassword(PASSWORD) },
  });
  const business = await db.business.create({
    data: { businessCode: `BZ-CAT${String(n).padStart(5, "0")}`, clientId: client.id, name: `Shop ${tag}`, category: "retail", status: opts.businessStatus ?? "ACTIVE" },
  });
  await db.businessMembership.create({ data: { userId: user.id, businessId: business.id, role: "OWNER" } });
  const { ctx, cookie } = await ctxFromUser(user.id);
  return { client, user, business, ctx, cookie };
}

/** Adds another business (and membership for the owner) to a tenant. The tenant ctx must be rebuilt afterwards. */
export async function addBusiness(t: Tenant, name: string) {
  const n = next();
  const b = await db.business.create({
    data: { businessCode: `BZ-CAT${String(n).padStart(5, "0")}`, clientId: t.client.id, name, category: "retail", status: "ACTIVE" },
  });
  await db.businessMembership.create({ data: { userId: t.user.id, businessId: b.id, role: "OWNER" } });
  const { ctx, cookie } = await ctxFromUser(t.user.id);
  t.ctx = ctx;
  t.cookie = cookie;
  return b;
}

export async function makeAdminSession(email = "admin@example.com") {
  const admin = (await db.user.findUnique({ where: { email } })) ?? (await makeAdmin(email));
  const { ctx, cookie } = await ctxFromUser(admin.id, "192.0.2.10");
  return { admin, ctx, cookie };
}

/** Minimal valid-looking image bytes (magic bytes + padding). */
export const PNG_BYTES = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
export const JPEG_BYTES = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
export const WEBP_BYTES = () => Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x20, 0, 0, 0]), Buffer.from("WEBP"), Buffer.alloc(32, 3)]);

/** Build a NextRequest carrying a session cookie and a same-origin header, ready for a route handler. */
export function req(method: string, path: string, opts: { cookie?: string; body?: unknown; form?: FormData; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { host: "localhost:3000", origin: "http://localhost:3000", "sec-fetch-site": "same-origin", "user-agent": "vitest" };
  if (opts.cookie) headers.cookie = opts.cookie;
  Object.assign(headers, opts.headers ?? {});
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  return new NextRequest(`http://localhost:3000${path}`, { method, headers, body });
}

export const seg = <P>(params: P) => ({ params: Promise.resolve(params) });

/** An order with a verified transaction (paid) or none (pending), attached to a QR. */
export async function makeOrder(opts: { businessId: string; qrCodeId?: string | null; totalMinor: number; paid: boolean; refundedMinor?: number; duplicate?: boolean }) {
  const n = next();
  const order = await db.order.create({
    data: {
      orderCode: `ORD-TEST-${String(n).padStart(6, "0")}`,
      publicId: randomToken(12),
      businessId: opts.businessId,
      qrCodeId: opts.qrCodeId ?? null,
      status: opts.paid ? "PAID" : "PENDING_PAYMENT",
      subtotalMinor: opts.totalMinor,
      totalMinor: opts.totalMinor,
      expiresAt: new Date(Date.now() + 3600_000),
      paidAt: opts.paid ? new Date() : null,
    },
  });
  if (opts.paid) {
    const attempt = await db.paymentAttempt.create({
      data: { orderId: order.id, provider: "DEV_SIMULATOR", status: "SUCCEEDED", amountMinor: opts.totalMinor, idempotencyKey: randomToken(12), expiresAt: new Date(Date.now() + 3600_000) },
    });
    await db.paymentTransaction.create({
      data: {
        txnRef: `TXN-TEST-${String(n).padStart(6, "0")}`,
        orderId: order.id,
        attemptId: attempt.id,
        provider: "DEV_SIMULATOR",
        providerPaymentId: `pay_${randomToken(8)}`,
        amountMinor: opts.totalMinor,
        refundedMinor: opts.refundedMinor ?? 0,
        isDuplicate: opts.duplicate ?? false,
        verificationSource: "WEBHOOK",
      },
    });
  }
  return order;
}
