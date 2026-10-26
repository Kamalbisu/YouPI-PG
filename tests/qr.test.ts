import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { pepperHash } from "@/lib/crypto";
import { createProduct, archiveProduct } from "@/server/services/products";
import { createOrderQr, createQr, getQr, listQr, qrUrl, regenerateQr, resolveQr, revokeQr } from "@/server/services/qr";
import { renderQrPdf, renderQrPng } from "@/server/services/qr-render";
import { anonCtx, resetDb } from "./helpers";
import { addBusiness, makeAdminSession, makeOrder, makeTenant, req, seg } from "./helpers-catalog";

import { GET as clientPngGET } from "@/app/api/client/qr/[id]/png/route";
import { GET as clientPdfGET } from "@/app/api/client/qr/[id]/pdf/route";
import { GET as adminPngGET } from "@/app/api/admin/qr/[id]/png/route";
import { GET as adminPdfGET } from "@/app/api/admin/qr/[id]/pdf/route";
import { POST as clientRevokePOST } from "@/app/api/client/qr/[id]/revoke/route";
import { POST as clientRegeneratePOST } from "@/app/api/client/qr/[id]/regenerate/route";
import { POST as adminRevokePOST } from "@/app/api/admin/qr/[id]/revoke/route";
import { GET as clientQrGET, POST as clientQrPOST } from "@/app/api/client/qr/route";
import { GET as adminQrGET } from "@/app/api/admin/qr/route";

async function code(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
  return "NO_ERROR";
}

const biz = (businessId: string, extra: Record<string, unknown> = {}) => ({ businessId, type: "BUSINESS", label: "Front counter", ...extra });

beforeEach(async () => {
  await resetDb();
});

describe("qr creation", () => {
  it("creates one QR of each type with a long unguessable token and the pay URL", async () => {
    const a = await makeTenant();
    const product = await createProduct(a.ctx, { businessId: a.business.id, name: "Tea", priceMinor: 5000 });
    const order = await makeOrder({ businessId: a.business.id, totalMinor: 9900, paid: false });

    const b = await createQr(a.ctx, biz(a.business.id));
    const p = await createQr(a.ctx, { businessId: a.business.id, type: "PRODUCT", label: "Tea QR", productId: product.id });
    const o = await createQr(a.ctx, { businessId: a.business.id, type: "ORDER", label: "Order QR", orderId: order.id });
    const d = await createQr(a.ctx, { businessId: a.business.id, type: "DYNAMIC_PAYMENT", label: "Pay any", allowCustomAmount: true, minAmountMinor: 1000, maxAmountMinor: 500000 });
    const f = await createQr(a.ctx, { businessId: a.business.id, type: "DYNAMIC_PAYMENT", label: "Pay 250", fixedAmountMinor: 25000 });

    const all = [b, p, o, d, f];
    expect(all.map((x) => x.type)).toEqual(["BUSINESS", "PRODUCT", "ORDER", "DYNAMIC_PAYMENT", "DYNAMIC_PAYMENT"]);
    for (const q of all) {
      expect(q.token.length).toBeGreaterThanOrEqual(24);
      expect(q.token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(q.url).toBe(qrUrl(q.token));
      expect(q.url).toMatch(/\/pay\/q\/[A-Za-z0-9_-]{24,}$/);
      expect(q.status).toBe("ACTIVE");
    }
    expect(new Set(all.map((x) => x.token)).size).toBe(all.length);
    expect(p.productId).toBe(product.id);
    expect(o.orderId).toBe(order.id);
    expect(f.fixedAmountMinor).toBe(25000);
    expect(d.allowCustomAmount).toBe(true);
    // An order QR expires with its order unless told otherwise.
    expect(o.expiresAt?.getTime()).toBe(order.expiresAt.getTime());
    expect(await db.auditLog.count({ where: { action: "qr.create" } })).toBe(5);
  });

  it("produces distinct tokens across many creations", async () => {
    const a = await makeTenant();
    const tokens = new Set<string>();
    for (let i = 0; i < 25; i++) tokens.add((await createQr(a.ctx, biz(a.business.id, { label: `QR ${i + 10}` }))).token);
    expect(tokens.size).toBe(25);
  });

  it("rejects a product from another business or client (404) and an archived product (422)", async () => {
    const a = await makeTenant();
    const other = await makeTenant();
    const foreign = await createProduct(other.ctx, { businessId: other.business.id, name: "Theirs", priceMinor: 1000 });
    expect(await code(() => createQr(a.ctx, { businessId: a.business.id, type: "PRODUCT", label: "Steal", productId: foreign.id }))).toBe("NOT_FOUND");

    // A second business of the same client: the product must belong to the QR's own business.
    const second = await addBusiness(a, "Second shop");
    const inSecond = await createProduct(a.ctx, { businessId: second.id, name: "Other shop item", priceMinor: 1000 });
    expect(await code(() => createQr(a.ctx, { businessId: a.business.id, type: "PRODUCT", label: "Cross", productId: inSecond.id }))).toBe("NOT_FOUND");

    const mine = await createProduct(a.ctx, { businessId: a.business.id, name: "Mine", priceMinor: 1000 });
    await archiveProduct(a.ctx, { id: mine.id });
    expect(await code(() => createQr(a.ctx, { businessId: a.business.id, type: "PRODUCT", label: "Old", productId: mine.id }))).toBe("VALIDATION");
    expect(await db.qrCode.count()).toBe(0);
  });

  it("rejects shape violations with VALIDATION", async () => {
    const a = await makeTenant();
    const product = await createProduct(a.ctx, { businessId: a.business.id, name: "Tea", priceMinor: 5000 });
    const bad = (extra: Record<string, unknown>) => code(() => createQr(a.ctx, biz(a.business.id, extra)));

    expect(await bad({ label: "x" })).toBe("VALIDATION");
    expect(await bad({ label: "y".repeat(81) })).toBe("VALIDATION");
    expect(await bad({ type: "NOPE" })).toBe("VALIDATION");
    expect(await bad({ type: "PRODUCT" })).toBe("VALIDATION"); // no product
    expect(await bad({ productId: product.id })).toBe("VALIDATION"); // product on a BUSINESS QR
    expect(await bad({ type: "ORDER" })).toBe("VALIDATION"); // no order
    expect(await bad({ type: "DYNAMIC_PAYMENT" })).toBe("VALIDATION"); // neither fixed nor custom
    expect(await bad({ fixedAmountMinor: 1000 })).toBe("VALIDATION"); // fixed on a non-payment QR
    expect(await bad({ type: "DYNAMIC_PAYMENT", fixedAmountMinor: 1000, allowCustomAmount: true })).toBe("VALIDATION");
    expect(await bad({ type: "DYNAMIC_PAYMENT", fixedAmountMinor: 0 })).toBe("VALIDATION");
    expect(await bad({ type: "DYNAMIC_PAYMENT", fixedAmountMinor: -5 })).toBe("VALIDATION");
    expect(await bad({ type: "DYNAMIC_PAYMENT", fixedAmountMinor: 10.5 })).toBe("VALIDATION");
    expect(await bad({ type: "DYNAMIC_PAYMENT", minAmountMinor: 100 })).toBe("VALIDATION"); // min without custom
    expect(await bad({ type: "DYNAMIC_PAYMENT", allowCustomAmount: true, minAmountMinor: 900, maxAmountMinor: 100 })).toBe("VALIDATION");
    expect(await bad({ expiresAt: new Date(Date.now() - 1000).toISOString() })).toBe("VALIDATION");
    expect(await bad({ expiresAt: "not a date" })).toBe("VALIDATION");
    expect(await code(() => createQr(a.ctx, { type: "BUSINESS", label: "No business" }))).toBe("VALIDATION");
    expect(await db.qrCode.count()).toBe(0);
  });

  it("refuses a second QR for the same order and an order from another business", async () => {
    const a = await makeTenant();
    const other = await makeTenant();
    const order = await makeOrder({ businessId: a.business.id, totalMinor: 1000, paid: false });
    const foreignOrder = await makeOrder({ businessId: other.business.id, totalMinor: 1000, paid: false });
    await createQr(a.ctx, { businessId: a.business.id, type: "ORDER", label: "First", orderId: order.id });
    expect(await code(() => createQr(a.ctx, { businessId: a.business.id, type: "ORDER", label: "Second", orderId: order.id }))).toBe("CONFLICT");
    expect(await code(() => createQr(a.ctx, { businessId: a.business.id, type: "ORDER", label: "Foreign", orderId: foreignOrder.id }))).toBe("NOT_FOUND");
  });

  it("refuses a suspended business", async () => {
    const a = await makeTenant({ businessStatus: "SUSPENDED" });
    expect(await code(() => createQr(a.ctx, biz(a.business.id)))).toBe("CONFLICT");
  });

  it("enforces permissions and tenant isolation", async () => {
    const noPerm = await makeTenant({ permissions: ["products.manage"] });
    expect(await code(() => createQr(noPerm.ctx, biz(noPerm.business.id)))).toBe("FORBIDDEN");
    expect(await code(() => listQr(noPerm.ctx, {}))).toBe("FORBIDDEN");

    expect(await code(() => createQr(anonCtx(), biz(noPerm.business.id)))).toBe("UNAUTHENTICATED");

    const a = await makeTenant();
    const b = await makeTenant();
    expect(await code(() => createQr(a.ctx, biz(b.business.id)))).toBe("NOT_FOUND");
    expect(await db.qrCode.count()).toBe(0);
  });

  it("createOrderQr binds an order QR labelled and expiring with the order, inside the caller's transaction", async () => {
    const a = await makeTenant();
    const other = await makeTenant();
    const order = await makeOrder({ businessId: a.business.id, totalMinor: 4200, paid: false });
    const q = await db.$transaction((tx) => createOrderQr(tx, { businessId: a.business.id, orderId: order.id, createdById: a.user.id }));
    expect(q.type).toBe("ORDER");
    expect(q.label).toBe(`Order ${order.orderCode}`);
    expect(q.expiresAt?.getTime()).toBe(order.expiresAt.getTime());
    expect(q.token.length).toBeGreaterThanOrEqual(24);
    const reloaded = await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { boundQr: true } });
    expect(reloaded.boundQr?.id).toBe(q.id);

    const order2 = await makeOrder({ businessId: a.business.id, totalMinor: 100, paid: false });
    await expect(db.$transaction((tx) => createOrderQr(tx, { businessId: other.business.id, orderId: order2.id }))).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Rolled back with the caller's transaction.
    const order3 = await makeOrder({ businessId: a.business.id, totalMinor: 100, paid: false });
    await expect(
      db.$transaction(async (tx) => {
        await createOrderQr(tx, { businessId: a.business.id, orderId: order3.id });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await db.qrCode.count({ where: { orderId: order3.id } })).toBe(0);
  });
});

describe("qr revoke, expiry and regenerate", () => {
  it("revoke records the reason, audits, and a second revoke conflicts", async () => {
    const a = await makeTenant();
    const q = await createQr(a.ctx, biz(a.business.id));
    const r = await revokeQr(a.ctx, { id: q.id, reason: "Printed on the wrong flyer" });
    expect(r.status).toBe("REVOKED");
    expect(r.revokedReason).toBe("Printed on the wrong flyer");
    expect(r.revokedAt).toBeInstanceOf(Date);
    expect(await code(() => revokeQr(a.ctx, { id: q.id, reason: "again please" }))).toBe("CONFLICT");
    expect(await db.auditLog.count({ where: { action: "qr.revoke", entityId: q.id } })).toBe(1);
    expect((await resolveQr(q.token)).state).toBe("revoked");
  });

  it("revoke rejects a missing or too-short reason and out-of-tenant ids", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const q = await createQr(a.ctx, biz(a.business.id));
    expect(await code(() => revokeQr(a.ctx, { id: q.id }))).toBe("VALIDATION");
    expect(await code(() => revokeQr(a.ctx, { id: q.id, reason: "no" }))).toBe("VALIDATION");
    expect(await code(() => revokeQr(a.ctx, { id: q.id, reason: "x".repeat(201) }))).toBe("VALIDATION");
    expect(await code(() => revokeQr(b.ctx, { id: q.id, reason: "not yours to revoke" }))).toBe("NOT_FOUND");
    expect(await code(() => revokeQr(a.ctx, { id: "does-not-exist", reason: "whatever" }))).toBe("NOT_FOUND");
    expect(await code(() => revokeQr(anonCtx(), { id: q.id, reason: "anonymous" }))).toBe("UNAUTHENTICATED");
    expect((await db.qrCode.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("ACTIVE");
  });

  it("an admin can revoke any client's QR", async () => {
    const a = await makeTenant();
    const { ctx } = await makeAdminSession();
    const q = await createQr(a.ctx, biz(a.business.id));
    const r = await revokeQr(ctx, { id: q.id, reason: "Abuse report" });
    expect(r.status).toBe("REVOKED");
  });

  it("regenerate revokes the old QR and links it to a new token in one step", async () => {
    const a = await makeTenant();
    const q = await createQr(a.ctx, { businessId: a.business.id, type: "DYNAMIC_PAYMENT", label: "Pay 500", fixedAmountMinor: 50000 });
    const fresh = await regenerateQr(a.ctx, { id: q.id, reason: "Leaked on social media" });
    expect(fresh.id).not.toBe(q.id);
    expect(fresh.token).not.toBe(q.token);
    expect(fresh.token.length).toBeGreaterThanOrEqual(24);
    expect(fresh.status).toBe("ACTIVE");
    expect(fresh.type).toBe("DYNAMIC_PAYMENT");
    expect(fresh.fixedAmountMinor).toBe(50000);
    expect(fresh.label).toBe("Pay 500");

    const old = await db.qrCode.findUniqueOrThrow({ where: { id: q.id } });
    expect(old.status).toBe("REVOKED");
    expect(old.replacedById).toBe(fresh.id);
    expect(old.revokedReason).toBe("Leaked on social media");
    expect((await resolveQr(q.token)).state).toBe("revoked");
    expect((await resolveQr(fresh.token)).state).toBe("ok");

    const detail = await getQr(a.ctx, { id: q.id });
    expect(detail.replacement?.id).toBe(fresh.id);

    expect(await code(() => regenerateQr(a.ctx, { id: q.id }))).toBe("CONFLICT");
    expect(await db.qrCode.count()).toBe(2);
    expect(await db.auditLog.count({ where: { action: "qr.regenerate" } })).toBe(1);
  });

  it("regenerate refuses ORDER QRs, foreign QRs and suspended businesses", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const order = await makeOrder({ businessId: a.business.id, totalMinor: 1000, paid: false });
    const oq = await createQr(a.ctx, { businessId: a.business.id, type: "ORDER", label: "Order QR", orderId: order.id });
    expect(await code(() => regenerateQr(a.ctx, { id: oq.id }))).toBe("BAD_REQUEST");

    const q = await createQr(a.ctx, biz(a.business.id));
    expect(await code(() => regenerateQr(b.ctx, { id: q.id }))).toBe("NOT_FOUND");
    await db.business.update({ where: { id: a.business.id }, data: { status: "SUSPENDED" } });
    expect(await code(() => regenerateQr(a.ctx, { id: q.id }))).toBe("CONFLICT");
    expect((await db.qrCode.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("ACTIVE");
  });

  it("an expired QR resolves as expired and a regenerated copy of an expired QR gets no stale expiry", async () => {
    const a = await makeTenant();
    const q = await createQr(a.ctx, biz(a.business.id, { expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
    expect((await resolveQr(q.token)).state).toBe("ok");
    await db.qrCode.update({ where: { id: q.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await resolveQr(q.token)).state).toBe("expired");
    const fresh = await regenerateQr(a.ctx, { id: q.id });
    expect(fresh.expiresAt).toBeNull();
    expect((await resolveQr(fresh.token)).state).toBe("ok");
  });
});

describe("resolveQr", () => {
  it("returns ok with the QR and business, and non-ok states leak nothing", async () => {
    const a = await makeTenant();
    const q = await createQr(a.ctx, biz(a.business.id));
    const ok = await resolveQr(q.token);
    expect(ok.state).toBe("ok");
    if (ok.state !== "ok") throw new Error("unreachable");
    expect(ok.qr.id).toBe(q.id);
    expect(ok.business.name).toBe(a.business.name);
    expect(JSON.stringify(ok)).not.toMatch(/clientId|createdById|revokedReason/);

    for (const t of ["", "short", "x".repeat(200), "has spaces in it!!", "../../etc/passwd", "a'b\"c;--  ", "A".repeat(32)]) {
      const r = await resolveQr(t);
      expect(r).toEqual({ state: "not_found", qr: null, business: null });
    }
    // Wrong type input must not throw.
    expect((await resolveQr(undefined as unknown as string)).state).toBe("not_found");

    await revokeQr(a.ctx, { id: q.id, reason: "Pulled from circulation" });
    expect(await resolveQr(q.token)).toEqual({ state: "revoked", qr: null, business: null });
  });

  it("reports business_unavailable for a suspended business", async () => {
    const a = await makeTenant();
    const q = await createQr(a.ctx, biz(a.business.id));
    await db.business.update({ where: { id: a.business.id }, data: { status: "SUSPENDED" } });
    expect(await resolveQr(q.token)).toEqual({ state: "business_unavailable", qr: null, business: null });
    expect(await db.qrScan.count()).toBe(0);
  });

  it("counts a scan, de-dupes the same IP within 60 seconds, and counts a different IP", async () => {
    const a = await makeTenant();
    const q = await createQr(a.ctx, biz(a.business.id));
    const mobile = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148";
    await resolveQr(q.token, { ip: "203.0.113.5", userAgent: mobile });
    await resolveQr(q.token, { ip: "203.0.113.5", userAgent: mobile });
    await resolveQr(q.token, { ip: "203.0.113.5", userAgent: mobile });
    let row = await db.qrCode.findUniqueOrThrow({ where: { id: q.id } });
    expect(row.scanCount).toBe(1);
    expect(row.lastScannedAt).toBeInstanceOf(Date);
    expect(await db.qrScan.count({ where: { qrCodeId: q.id } })).toBe(1);

    await resolveQr(q.token, { ip: "203.0.113.6", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120" });
    row = await db.qrCode.findUniqueOrThrow({ where: { id: q.id } });
    expect(row.scanCount).toBe(2);

    // After the window, the same IP counts again.
    await db.qrScan.updateMany({ data: { scannedAt: new Date(Date.now() - 61_000) } });
    await resolveQr(q.token, { ip: "203.0.113.5", userAgent: mobile });
    expect((await db.qrCode.findUniqueOrThrow({ where: { id: q.id } })).scanCount).toBe(3);

    const classes = (await db.qrScan.findMany({ select: { userAgentClass: true } })).map((s) => s.userAgentClass).sort();
    expect(classes).toEqual(["desktop", "mobile", "mobile"]);
  });

  it("de-dupes concurrent scans from one IP and keeps scanCount equal to the scan rows", async () => {
    const a = await makeTenant();
    const q = await createQr(a.ctx, biz(a.business.id));
    await Promise.all(Array.from({ length: 8 }, () => resolveQr(q.token, { ip: "203.0.113.50", userAgent: "Mozilla/5.0 Android Mobile" })));
    expect(await db.qrScan.count({ where: { qrCodeId: q.id } })).toBe(1);
    expect((await db.qrCode.findUniqueOrThrow({ where: { id: q.id } })).scanCount).toBe(1);
  });

  it("scans without an IP always count, and the same QR scanned on separate QRs is not de-duped across them", async () => {
    const a = await makeTenant();
    const q1 = await createQr(a.ctx, biz(a.business.id, { label: "One QR" }));
    const q2 = await createQr(a.ctx, biz(a.business.id, { label: "Two QR" }));
    await resolveQr(q1.token);
    await resolveQr(q1.token, { ip: null });
    expect((await db.qrCode.findUniqueOrThrow({ where: { id: q1.id } })).scanCount).toBe(2);
    expect((await db.qrScan.findMany({ where: { qrCodeId: q1.id } })).every((s) => s.ipHash === null)).toBe(true);

    await resolveQr(q1.token, { ip: "203.0.113.9" });
    await resolveQr(q2.token, { ip: "203.0.113.9" });
    expect((await db.qrCode.findUniqueOrThrow({ where: { id: q2.id } })).scanCount).toBe(1);
  });

  it("never stores a raw IP: ipHash is the peppered hash and no scan column contains the address", async () => {
    const a = await makeTenant();
    const q = await createQr(a.ctx, biz(a.business.id));
    const ip = "198.51.100.77";
    await resolveQr(q.token, { ip, userAgent: "Mozilla/5.0 Mobile" });
    const scans = await db.qrScan.findMany({ where: { qrCodeId: q.id } });
    expect(scans).toHaveLength(1);
    expect(scans[0].ipHash).toBe(pepperHash(ip));
    expect(scans[0].ipHash).not.toBe(ip);
    expect(JSON.stringify(scans)).not.toContain(ip);
    // The whole row, including the QR it belongs to, is free of the address.
    const raw = await db.$queryRaw<{ t: string }[]>`SELECT row_to_json(s)::text AS t FROM "qr_scans" s`;
    expect(raw.map((r) => r.t).join("")).not.toContain(ip);
    expect(JSON.stringify(await db.qrCode.findUniqueOrThrow({ where: { id: q.id } }))).not.toContain(ip);
  });
});

describe("qr stats", () => {
  it("gives 30 day buckets, scan totals and revenue from verified transactions only", async () => {
    const a = await makeTenant();
    const q = await createQr(a.ctx, biz(a.business.id));
    const now = new Date();
    await db.qrScan.createMany({
      data: [
        { qrCodeId: q.id, scannedAt: now },
        { qrCodeId: q.id, scannedAt: now },
        { qrCodeId: q.id, scannedAt: new Date(Date.now() - 3 * 86_400_000) },
        { qrCodeId: q.id, scannedAt: new Date(Date.now() - 45 * 86_400_000) }, // outside the window
      ],
    });
    await db.qrCode.update({ where: { id: q.id }, data: { scanCount: 4, lastScannedAt: now } });

    await makeOrder({ businessId: a.business.id, qrCodeId: q.id, totalMinor: 10000, paid: true, refundedMinor: 2500 });
    await makeOrder({ businessId: a.business.id, qrCodeId: q.id, totalMinor: 30000, paid: true });
    await makeOrder({ businessId: a.business.id, qrCodeId: q.id, totalMinor: 99999, paid: false }); // pending: not revenue
    await makeOrder({ businessId: a.business.id, qrCodeId: q.id, totalMinor: 7777, paid: true, duplicate: true }); // duplicate txn: not revenue
    await makeOrder({ businessId: a.business.id, totalMinor: 55555, paid: true }); // other QR / no QR

    const s = (await getQr(a.ctx, { id: q.id })).stats;
    expect(s.scanCount).toBe(4);
    expect(s.lastScannedAt).toBeInstanceOf(Date);
    expect(s.scansByDay).toHaveLength(30);
    expect(s.scansByDay.reduce((n, d) => n + d.count, 0)).toBe(3);
    expect(s.scansByDay.at(-1)?.count).toBe(2);
    expect(s.ordersCount).toBe(4);
    expect(s.paidTransactions).toBe(2);
    expect(s.revenueMinor).toBe(40000);
    expect(s.refundedMinor).toBe(2500);
    expect(s.netRevenueMinor).toBe(37500);
  });

  it("a QR with no activity has zero stats", async () => {
    const a = await makeTenant();
    const q = await createQr(a.ctx, biz(a.business.id));
    const s = (await getQr(a.ctx, { id: q.id })).stats;
    expect(s).toMatchObject({ scanCount: 0, lastScannedAt: null, ordersCount: 0, paidTransactions: 0, revenueMinor: 0, netRevenueMinor: 0 });
    expect(s.scansByDay.every((d) => d.count === 0)).toBe(true);
  });

  it("includes the order bound to an ORDER QR, and hides another tenant's QR as 404", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const order = await makeOrder({ businessId: a.business.id, totalMinor: 12000, paid: true });
    const q = await createQr(a.ctx, { businessId: a.business.id, type: "ORDER", label: "Order QR", orderId: order.id });
    const s = (await getQr(a.ctx, { id: q.id })).stats;
    expect(s.ordersCount).toBe(1);
    expect(s.revenueMinor).toBe(12000);
    expect(await code(() => getQr(b.ctx, { id: q.id }))).toBe("NOT_FOUND");
  });
});

describe("qr listing", () => {
  it("scopes a client to their own businesses and filters by type, status and search", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const q1 = await createQr(a.ctx, biz(a.business.id, { label: "Counter" }));
    const q2 = await createQr(a.ctx, { businessId: a.business.id, type: "DYNAMIC_PAYMENT", label: "Tip jar", allowCustomAmount: true });
    const q3 = await createQr(a.ctx, biz(a.business.id, { label: "Old flyer" }));
    await createQr(b.ctx, biz(b.business.id, { label: "Counter" }));
    await revokeQr(a.ctx, { id: q3.id, reason: "Retired design" });
    const q4 = await createQr(a.ctx, biz(a.business.id, { label: "Lapsed" }));
    await db.qrCode.update({ where: { id: q4.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const all = await listQr(a.ctx, {});
    expect(all.total).toBe(4);
    expect(all.items.map((i) => i.id)).not.toContain(undefined);
    const ids = (r: { items: { id: string }[] }) => r.items.map((i) => i.id).sort();
    expect(ids(await listQr(a.ctx, { type: "DYNAMIC_PAYMENT" }))).toEqual([q2.id]);
    expect(ids(await listQr(a.ctx, { status: "revoked" }))).toEqual([q3.id]);
    expect(ids(await listQr(a.ctx, { status: "expired" }))).toEqual([q4.id]);
    expect(ids(await listQr(a.ctx, { status: "active" }))).toEqual([q1.id, q2.id].sort());
    expect(ids(await listQr(a.ctx, { q: "flyer" }))).toEqual([q3.id]);
    // Another client's business id is a 404, not an empty list.
    expect(await code(() => listQr(a.ctx, { businessId: b.business.id }))).toBe("NOT_FOUND");
    expect(await code(() => listQr(a.ctx, { type: "NOPE" }))).toBe("VALIDATION");
  });

  it("lets an admin list across clients and filter by client and business", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const { ctx } = await makeAdminSession();
    const qa = await createQr(a.ctx, biz(a.business.id));
    const qb = await createQr(b.ctx, biz(b.business.id));
    const ids = (r: { items: { id: string }[] }) => r.items.map((i) => i.id).sort();
    expect(ids(await listQr(ctx, {}))).toEqual([qa.id, qb.id].sort());
    expect(ids(await listQr(ctx, { clientId: a.client.id }))).toEqual([qa.id]);
    expect(ids(await listQr(ctx, { businessId: b.business.id }))).toEqual([qb.id]);
  });

  it("paginates", async () => {
    const a = await makeTenant();
    for (let i = 0; i < 5; i++) await createQr(a.ctx, biz(a.business.id, { label: `Label ${i + 10}` }));
    const page = await listQr(a.ctx, { page: "2", pageSize: "2" });
    expect(page.total).toBe(5);
    expect(page.items).toHaveLength(2);
  });
});

describe("qr rendering", () => {
  it("renders a PNG and a PDF from the token", async () => {
    const png = await renderQrPng("tokentokentokentokentoken1234");
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const pdf = await renderQrPdf({ token: "tokentokentokentokentoken1234", label: "Front counter", businessName: "Shop — Café", currency: "INR", fixedAmountMinor: 25000 });
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect(pdf.length).toBeGreaterThan(500);
  });
});

describe("qr routes", () => {
  it("serves PNG and PDF downloads to the owner with safe headers", async () => {
    const a = await makeTenant();
    const q = await createQr(a.ctx, biz(a.business.id));

    const png = await clientPngGET(req("GET", `/api/client/qr/${q.id}/png`, { cookie: a.cookie }), seg({ id: q.id }));
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(png.headers.get("content-disposition")).toContain("attachment");
    expect(png.headers.get("cache-control")).toContain("no-store");
    expect(png.headers.get("x-content-type-options")).toBe("nosniff");
    const pngBytes = Buffer.from(await png.arrayBuffer());
    expect([...pngBytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const pdf = await clientPdfGET(req("GET", `/api/client/qr/${q.id}/pdf`, { cookie: a.cookie }), seg({ id: q.id }));
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString()).toBe("%PDF");
  });

  it("returns 404 for another client's QR, 401 without a session, 403 for the wrong role and 403 without qr.manage", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const noPerm = await makeTenant({ permissions: ["products.manage"] });
    const q = await createQr(a.ctx, biz(a.business.id));
    const p = seg({ id: q.id });

    expect((await clientPngGET(req("GET", `/api/client/qr/${q.id}/png`, { cookie: b.cookie }), p)).status).toBe(404);
    expect((await clientPdfGET(req("GET", `/api/client/qr/${q.id}/pdf`, { cookie: b.cookie }), p)).status).toBe(404);
    expect((await clientPngGET(req("GET", `/api/client/qr/${q.id}/png`), p)).status).toBe(401);
    expect((await clientPdfGET(req("GET", `/api/client/qr/${q.id}/pdf`), p)).status).toBe(401);
    expect((await clientPngGET(req("GET", `/api/client/qr/${q.id}/png`, { cookie: noPerm.cookie }), p)).status).toBe(403);
    // A client session cannot use the admin download routes.
    expect((await adminPngGET(req("GET", `/api/admin/qr/${q.id}/png`, { cookie: a.cookie }), p)).status).toBe(403);
    expect((await clientPngGET(req("GET", `/api/client/qr/nope/png`, { cookie: a.cookie }), seg({ id: "nope" }))).status).toBe(404);
  });

  it("lets an admin download any client's QR", async () => {
    const a = await makeTenant();
    const { cookie } = await makeAdminSession();
    const q = await createQr(a.ctx, biz(a.business.id));
    const png = await adminPngGET(req("GET", `/api/admin/qr/${q.id}/png`, { cookie }), seg({ id: q.id }));
    expect(png.status).toBe(200);
    expect(Buffer.from(await png.arrayBuffer()).subarray(1, 4).toString()).toBe("PNG");
    const pdf = await adminPdfGET(req("GET", `/api/admin/qr/${q.id}/pdf`, { cookie }), seg({ id: q.id }));
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString()).toBe("%PDF");
  });

  it("revokes and regenerates over HTTP, with the error shape and CSRF protection", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const q = await createQr(a.ctx, biz(a.business.id));
    const p = seg({ id: q.id });

    const crossSite = await clientRevokePOST(
      req("POST", `/api/client/qr/${q.id}/revoke`, { cookie: a.cookie, body: { reason: "csrf attempt" }, headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } }),
      p,
    );
    expect(crossSite.status).toBe(403);
    expect((await db.qrCode.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("ACTIVE");

    const badReason = await clientRevokePOST(req("POST", `/api/client/qr/${q.id}/revoke`, { cookie: a.cookie, body: { reason: "" } }), p);
    expect(badReason.status).toBe(422);
    expect((await badReason.json()).error.code).toBe("VALIDATION");

    const foreign = await clientRevokePOST(req("POST", `/api/client/qr/${q.id}/revoke`, { cookie: b.cookie, body: { reason: "stealing it" } }), p);
    expect(foreign.status).toBe(404);

    const regen = await clientRegeneratePOST(req("POST", `/api/client/qr/${q.id}/regenerate`, { cookie: a.cookie, body: { reason: "Reprint" } }), p);
    expect(regen.status).toBe(200);
    const fresh = (await regen.json()).data;
    expect(fresh.token).not.toBe(q.token);
    expect(fresh.url).toBe(qrUrl(fresh.token));

    const again = await clientRevokePOST(req("POST", `/api/client/qr/${q.id}/revoke`, { cookie: a.cookie, body: { reason: "already revoked by regenerate" } }), p);
    expect(again.status).toBe(409);

    const { cookie } = await makeAdminSession();
    const q2 = await createQr(a.ctx, biz(a.business.id, { label: "Second QR" }));
    const adminRevoke = await adminRevokePOST(req("POST", `/api/admin/qr/${q2.id}/revoke`, { cookie, body: { reason: "Admin takedown" } }), seg({ id: q2.id }));
    expect(adminRevoke.status).toBe(200);
    expect((await db.qrCode.findUniqueOrThrow({ where: { id: q2.id } })).status).toBe("REVOKED");
  });

  it("creates and lists over HTTP with scoping", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const created = await clientQrPOST(req("POST", "/api/client/qr", { cookie: a.cookie, body: biz(a.business.id) }), seg({}));
    expect(created.status).toBe(200);
    const q = (await created.json()).data;
    expect(q.url).toBe(qrUrl(q.token));

    const invalid = await clientQrPOST(req("POST", "/api/client/qr", { cookie: a.cookie, body: biz(a.business.id, { label: "" }) }), seg({}));
    expect(invalid.status).toBe(422);
    const foreign = await clientQrPOST(req("POST", "/api/client/qr", { cookie: b.cookie, body: biz(a.business.id) }), seg({}));
    expect(foreign.status).toBe(404);
    const anon = await clientQrPOST(req("POST", "/api/client/qr", { body: biz(a.business.id) }), seg({}));
    expect(anon.status).toBe(401);

    const mine = await clientQrGET(req("GET", "/api/client/qr", { cookie: a.cookie }), seg({}));
    expect((await mine.json()).data.total).toBe(1);
    const theirs = await clientQrGET(req("GET", "/api/client/qr", { cookie: b.cookie }), seg({}));
    expect((await theirs.json()).data.total).toBe(0);

    const { cookie } = await makeAdminSession();
    const adminAll = await adminQrGET(req("GET", "/api/admin/qr", { cookie }), seg({}));
    expect((await adminAll.json()).data.total).toBe(1);
    expect((await adminQrGET(req("GET", "/api/admin/qr", { cookie: a.cookie }), seg({}))).status).toBe(403);
  });
});
