import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { hashPassword } from "@/server/auth/password";
import { createSession, cookieName } from "@/server/auth/session";
import type { Ctx } from "@/server/auth/types";

export const PASSWORD = "Correct-Horse-Battery-9";
export const APP = "http://localhost:3000";

/** Empties every table (including the append-only audit log) between tests. */
export async function resetDb() {
  const rows = await db.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (rows.length === 0) return;
  const names = rows.map((r) => `"${r.tablename}"`).join(", ");
  await db.$executeRawUnsafe(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
}

export const anonCtx = (ip = "203.0.113.5"): Ctx => ({ actor: null, ip, userAgent: "vitest" });

export async function makeAdmin(email = "admin@example.com") {
  return db.user.create({
    data: { email, name: "Admin", username: "admin", role: "ADMIN", status: "ACTIVE", passwordHash: await hashPassword(PASSWORD) },
  });
}

let n = 0;
export async function makeUser(username = `user${++n}`, mobile?: string) {
  return db.user.create({
    data: {
      name: `Name ${username}`,
      username,
      mobile: mobile ?? `+9198${String(10000000 + n * 7).slice(-8)}`,
      role: "USER",
      status: "ACTIVE",
      passwordHash: await hashPassword(PASSWORD),
      mobileVerifiedAt: new Date(),
    },
  });
}

/** A signed-in context (as built by route()) for a user row. */
export async function ctxFor(user: { id: string; role: "ADMIN" | "USER"; name: string; username: string }, ip = "203.0.113.9"): Promise<Ctx> {
  const { session } = await createSession(user.id, { ip, userAgent: "vitest" });
  return { actor: { userId: user.id, role: user.role, name: user.name, username: user.username, sessionId: session.id }, ip, userAgent: "vitest" };
}

/** A real session token, for calling route handlers with a cookie. */
export async function cookieFor(user: { id: string }): Promise<string> {
  const { token } = await createSession(user.id, { ip: null, userAgent: "vitest" });
  return `${cookieName()}=${token}`;
}

/** Tiny valid PNG (header + IHDR) and friends for upload tests. */
export const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]),
  Buffer.alloc(32, 1),
]);

export function pngFile(name = "qr.png", bytes: Buffer = PNG_BYTES, type = "image/png") {
  return new File([new Uint8Array(bytes)], name, { type });
}

interface ReqOpts {
  cookie?: string;
  body?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
  /** Defaults to the app's own origin so ordinary calls pass the CSRF check. */
  origin?: string | null;
}

export function req(method: string, path: string, o: ReqOpts = {}): NextRequest {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.origin !== null && !["GET", "HEAD"].includes(method)) headers.origin = o.origin ?? APP;
  if (o.cookie) headers.cookie = o.cookie;
  let body: BodyInit | undefined;
  if (o.form) body = o.form;
  else if (o.body !== undefined) {
    body = JSON.stringify(o.body);
    headers["content-type"] = "application/json";
  }
  return new NextRequest(`${APP}${path}`, { method, headers, body });
}

export const seg = (params: Record<string, string> = {}) => ({ params: Promise.resolve(params) });

/** Pull the 6 digit code out of a captured SMS. */
export const codeFrom = (content: string) => /\b(\d{6})\b/.exec(content)![1]!;
