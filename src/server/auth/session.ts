import { cookies, headers } from "next/headers";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { randomToken } from "@/lib/ids";
import { sha256Hex } from "@/lib/crypto";
import type { Actor, Ctx } from "./types";

const IDLE_MS = 8 * 3600 * 1000; // sliding idle timeout
const ABSOLUTE_MS = 7 * 24 * 3600 * 1000;
const TOUCH_EVERY_MS = 60 * 1000;

const secureCookies = () => env().APP_URL.startsWith("https://");
export const cookieName = () => (secureCookies() ? "__Host-yp_session" : "yp_session");

export async function createSession(userId: string, meta: { ip: string | null; userAgent: string | null }) {
  const token = randomToken(32);
  const now = Date.now();
  const session = await db.session.create({
    data: {
      userId,
      tokenHash: sha256Hex(token),
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 300),
      expiresAt: new Date(now + IDLE_MS),
      absoluteExpiresAt: new Date(now + ABSOLUTE_MS),
    },
  });
  return { token, session };
}

export async function setSessionCookie(token: string) {
  const jar = await cookies();
  jar.set(cookieName(), token, {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax",
    path: "/",
    maxAge: ABSOLUTE_MS / 1000,
  });
}

export async function clearSessionCookie() {
  const jar = await cookies();
  jar.set(cookieName(), "", { httpOnly: true, secure: secureCookies(), sameSite: "lax", path: "/", maxAge: 0 });
}

/** Resolve an opaque token to an Actor (or null). Slides the idle expiry. */
export async function actorFromToken(token: string | undefined | null): Promise<Actor | null> {
  if (!token) return null;
  const s = await db.session.findUnique({
    where: { tokenHash: sha256Hex(token) },
    include: { user: { select: { id: true, role: true, name: true, username: true, status: true } } },
  });
  const now = new Date();
  if (!s || s.revokedAt || s.expiresAt < now || s.absoluteExpiresAt < now) return null;
  const u = s.user;
  if (u.status !== "ACTIVE") return null;

  if (now.getTime() - s.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
    await db.session.update({
      where: { id: s.id },
      data: { lastSeenAt: now, expiresAt: new Date(Math.min(now.getTime() + IDLE_MS, s.absoluteExpiresAt.getTime())) },
    });
  }
  return { userId: u.id, role: u.role, name: u.name, username: u.username, sessionId: s.id };
}

export async function revokeSession(sessionId: string) {
  await db.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function revokeAllSessions(userId: string, exceptSessionId?: string | null) {
  await db.session.updateMany({
    where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
    data: { revokedAt: new Date() },
  });
}

/** Client IP honouring TRUST_PROXY. */
export function clientIp(h: Headers): string | null {
  if (env().TRUST_PROXY === "true") {
    const xff = h.get("x-forwarded-for");
    if (xff) return xff.split(",")[0]!.trim() || null;
    const real = h.get("x-real-ip");
    if (real) return real.trim();
  }
  return null; // client-supplied forwarding headers are untrusted unless TRUST_PROXY=true
}

/** Build the request context (actor + ip + UA) inside a request scope. */
export async function getCtx(): Promise<Ctx> {
  const [jar, h] = await Promise.all([cookies(), headers()]);
  const actor = await actorFromToken(jar.get(cookieName())?.value);
  return { actor, ip: clientIp(h), userAgent: h.get("user-agent") };
}

/** Context without resolving the user (public endpoints). */
export async function getPublicCtx(): Promise<Ctx> {
  const h = await headers();
  return { actor: null, ip: clientIp(h), userAgent: h.get("user-agent") };
}
