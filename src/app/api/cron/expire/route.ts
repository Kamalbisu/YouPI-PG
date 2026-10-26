import { route } from "@/server/api";
import { safeEqual } from "@/lib/crypto";
import { unauthenticated } from "@/lib/errors";
import { expireStaleOrders } from "@/server/services/payment-verification";

/**
 * Scheduled expiry of unpaid orders. Protected by a shared secret in the x-cron-secret header (or
 * Authorization: Bearer). CRON_SECRET is read from process.env directly; when it is unset the route
 * always answers 401 (it is never open).
 */
function provided(req: Request): string {
  const h = req.headers.get("x-cron-secret");
  if (h) return h;
  const auth = req.headers.get("authorization") ?? "";
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
}

async function run(req: Request) {
  const expected = process.env.CRON_SECRET;
  const given = provided(req);
  if (!expected || expected.length < 16 || !given || !safeEqual(given, expected)) throw unauthenticated("Invalid cron credentials");
  return expireStaleOrders();
}

export const POST = route(async (req) => run(req), { public: true, csrf: false });
export const GET = route(async (req) => run(req), { public: true });
