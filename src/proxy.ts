import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic gate only: sends visitors without a session cookie to the right login page.
 * Real authentication and authorization happen in server guards (page-guards / route()).
 */
export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const portal = pathname.startsWith("/admin") ? "admin" : pathname.startsWith("/client") ? "client" : null;
  if (!portal || pathname === `/${portal}/login`) return NextResponse.next();
  const has = req.cookies.has("yp_session") || req.cookies.has("__Host-yp_session");
  if (!has) return NextResponse.redirect(new URL(`/${portal}/login`, req.url));
  return NextResponse.next();
}

export const config = { matcher: ["/admin/:path*", "/client/:path*"] };
