import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ALL_CLIENT_PERMISSIONS } from "@/lib/permissions";
import { actorFromToken, cookieName, createSession } from "@/server/auth/session";
import { hashPassword } from "@/server/auth/password";
import type { Ctx } from "@/server/auth/types";
import { makeAdmin, PASSWORD } from "./helpers";

export { PASSWORD };

let seq = 0;

/** A real session for a user, returned as a service Ctx and as a Cookie header for route handlers. */
export async function sessionFor(userId: string, ip = "198.51.100.7"): Promise<{ ctx: Ctx; cookie: string }> {
  const { token } = await createSession(userId, { ip, userAgent: "vitest" });
  const actor = await actorFromToken(token);
  return { ctx: { actor, ip, userAgent: "vitest" }, cookie: `${cookieName()}=${token}` };
}

export async function adminSession(email = "admin@example.com") {
  const admin = (await db.user.findUnique({ where: { email } })) ?? (await makeAdmin(email));
  const s = await sessionFor(admin.id, "192.0.2.10");
  return { admin, ...s };
}

export interface Tenant {
  client: { id: string; name: string; email: string };
  owner: { id: string; email: string };
  business: { id: string; name: string };
  ctx: Ctx;
  cookie: string;
}

/**
 * A client account with an ACTIVE password-holding OWNER user and one ACTIVE business.
 * All client permissions are granted by default so tests can narrow them per case.
 */
export async function makeClientTenant(opts: { permissions?: string[]; maxBusinesses?: number; tag?: string; businessStatus?: "ACTIVE" | "PENDING_APPROVAL" } = {}): Promise<Tenant> {
  const n = ++seq;
  const tag = opts.tag ?? `a${n}`;
  const client = await db.client.create({
    data: {
      clientCode: `CL-ADM${String(n).padStart(5, "0")}`,
      name: `Client ${tag}`,
      contactName: `Owner ${tag}`,
      email: `owner-${tag}@shop.test`,
      permissions: opts.permissions ?? [...ALL_CLIENT_PERMISSIONS],
      maxBusinesses: opts.maxBusinesses ?? 3,
    },
  });
  const owner = await db.user.create({
    data: { email: `owner-${tag}@shop.test`, name: `Owner ${tag}`, role: "CLIENT", status: "ACTIVE", clientId: client.id, passwordHash: await hashPassword(PASSWORD) },
  });
  const business = await db.business.create({
    data: { businessCode: `BZ-ADM${String(n).padStart(5, "0")}`, clientId: client.id, name: `Shop ${tag}`, category: "retail", status: opts.businessStatus ?? "ACTIVE" },
  });
  await db.businessMembership.create({ data: { userId: owner.id, businessId: business.id, role: "OWNER" } });
  const s = await sessionFor(owner.id);
  return { client, owner, business, ...s };
}

/** Rebuild a tenant owner's session context (needed after memberships change, e.g. a new business). */
export async function refreshOwner(t: Tenant) {
  const s = await sessionFor(t.owner.id);
  t.ctx = s.ctx;
  t.cookie = s.cookie;
}

/** An additional business of the same client, with the owner as OWNER member. */
export async function addOwnedBusiness(t: Tenant, name: string, status: "ACTIVE" | "PENDING_APPROVAL" = "ACTIVE") {
  const n = ++seq;
  const b = await db.business.create({
    data: { businessCode: `BZ-ADM${String(n).padStart(5, "0")}`, clientId: t.client.id, name, category: "retail", status },
  });
  await db.businessMembership.create({ data: { userId: t.owner.id, businessId: b.id, role: "OWNER" } });
  await refreshOwner(t);
  return b;
}

/** A MANAGER user with a password, a member of one business only. */
export async function makeManager(t: Tenant, businessId: string = t.business.id, tag = `m${++seq}`) {
  const user = await db.user.create({
    data: { email: `mgr-${tag}@shop.test`, name: `Manager ${tag}`, role: "CLIENT", status: "ACTIVE", clientId: t.client.id, passwordHash: await hashPassword(PASSWORD) },
  });
  await db.businessMembership.create({ data: { userId: user.id, businessId, role: "MANAGER" } });
  const s = await sessionFor(user.id, "198.51.100.77");
  return { user, ...s };
}

/** The raw token inside an invite or reset link. */
export function tokenFromLink(link: string): string {
  const t = new URL(link).searchParams.get("token");
  if (!t) throw new Error("no token in link");
  return t;
}

export const PNG_BYTES = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
export const JPEG_BYTES = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
export const WEBP_BYTES = () => Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x20, 0, 0, 0]), Buffer.from("WEBP"), Buffer.alloc(32, 3)]);

export const fileOf = (bytes: Buffer | Uint8Array, name: string, type = "image/png") => new File([new Uint8Array(bytes)], name, { type });

/** A NextRequest with a session cookie and same-origin headers, ready for a route handler. */
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

/** Assert a promise rejects with an AppError of the given code. Returns the error for extra checks. */
export async function expectAppError(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code !== code) throw new Error(`expected ${code}, got ${err.code}: ${err.message}`);
    return err as { code: string; message: string; details?: unknown; status: number };
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}
