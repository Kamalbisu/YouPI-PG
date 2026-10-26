import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import { AppError } from "@/lib/errors";
import { env } from "@/lib/env";
import { actorFromToken, clientIp, cookieName } from "./auth/session";
import type { Ctx } from "./auth/types";

export interface RouteOpts {
  /** Public endpoint: no session is resolved or required. */
  public?: boolean;
  /** Skip the same-origin check (webhooks authenticate by signature instead). */
  csrf?: false;
}

type Handler<P> = (req: NextRequest, ctx: Ctx, params: P) => Promise<Response | unknown>;

function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  if (!origin) return fetchSite === "same-origin" || fetchSite === "none"; // non-browser clients without cookies are fine; browsers send Origin on POST
  try {
    const o = new URL(origin);
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    const app = new URL(env().APP_URL);
    return o.host === host || o.host === app.host;
  } catch {
    return false;
  }
}

export function errorResponse(e: unknown): NextResponse {
  if (e instanceof AppError) {
    const headers: Record<string, string> = {};
    const retry = (e.details as { retryAfterSec?: number } | undefined)?.retryAfterSec;
    if (e.code === "RATE_LIMITED" && retry) headers["Retry-After"] = String(retry);
    return NextResponse.json({ error: { code: e.code, message: e.message, details: e.details } }, { status: e.status, headers });
  }
  if (e instanceof ZodError) {
    return NextResponse.json({ error: { code: "VALIDATION", message: e.issues[0]?.message ?? "Invalid input" } }, { status: 422 });
  }
  console.error("Unhandled API error", e);
  return NextResponse.json({ error: { code: "INTERNAL", message: "Something went wrong. Please try again." } }, { status: 500 });
}

/**
 * Wraps a route handler: resolves the session into a Ctx, enforces same-origin on
 * state-changing requests, and converts thrown errors into a stable JSON error shape.
 * Return a Response for custom output, or any value to have it sent as `{ data }`.
 */
export function route<P = Record<string, string>>(handler: Handler<P>, opts: RouteOpts = {}) {
  return async (req: NextRequest, segment: { params: Promise<P> }): Promise<Response> => {
    try {
      const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
      if (mutating && opts.csrf !== false && !sameOrigin(req)) {
        throw new AppError("FORBIDDEN", "Cross-site request blocked");
      }
      const actor = opts.public ? null : await actorFromToken(req.cookies.get(cookieName())?.value);
      const ctx: Ctx = { actor, ip: clientIp(req.headers), userAgent: req.headers.get("user-agent") };
      const params = (await segment?.params) ?? ({} as P);
      const out = await handler(req, ctx, params);
      if (out instanceof Response) return out;
      return NextResponse.json({ data: out ?? { ok: true } });
    } catch (e) {
      return errorResponse(e);
    }
  };
}

/** Read a JSON body safely (size-limited). */
export async function jsonBody(req: NextRequest, maxBytes = 256 * 1024): Promise<unknown> {
  const text = await req.text();
  if (text.length > maxBytes) throw new AppError("BAD_REQUEST", "Request body too large");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError("BAD_REQUEST", "Body must be valid JSON");
  }
}

export function searchParams(req: NextRequest): Record<string, string> {
  return Object.fromEntries(req.nextUrl.searchParams.entries());
}
