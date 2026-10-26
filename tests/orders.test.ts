import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createProduct, archiveProduct } from "@/server/services/products";
import { createQr, revokeQr } from "@/server/services/qr";
import { createOrder, getOrder, listOrders, cancelOrder } from "@/server/services/orders";
import { POST as createOrderRoute } from "@/app/api/pay/orders/route";
import { GET as clientOrdersRoute } from "@/app/api/client/orders/route";
import { GET as clientOrderRoute } from "@/app/api/client/orders/[id]/route";
import { resetDb } from "./helpers";
import { code, customerCtx, idemKey, makeAdminSession, makeShop, placeOrder, req, seg } from "./helpers-payments";

beforeEach(async () => {
  await resetDb();
});

describe("order creation: server side pricing authority", () => {
  it("prices from the catalog and ignores client supplied prices and totals", async () => {
    const shop = await makeShop({ priceMinor: 12500 });
    const o = await createOrder(customerCtx(), {
      qrToken: shop.qrToken,
      items: [{ productId: shop.product.id, quantity: 3, priceMinor: 1, unitPriceMinor: 1, totalMinor: 1 }],
      totalMinor: 1,
      amountMinor: 1,
      customer: { name: "Asha" },
      idempotencyKey: idemKey(),
    });
    expect(o.totalMinor).toBe(37500);
    expect(o.status).toBe("PENDING_PAYMENT");
    expect(o.currency).toBe("INR");
    const row = await db.order.findUniqueOrThrow({ where: { id: o.orderId } });
    expect(row.totalMinor).toBe(37500);
    expect(row.businessId).toBe(shop.business.id);
  });

  it("rejects tampered quantities", async () => {
    const shop = await makeShop();
    for (const quantity of [0, -1, 101, 1.5]) {
      expect(await code(() => placeOrder(shop, { items: [{ productId: shop.product.id, quantity }] }))).toBe("VALIDATION");
    }
    expect(await db.order.count()).toBe(0);
  });

  it("rejects a product that belongs to another business", async () => {
    const a = await makeShop({ tag: "a" });
    const b = await makeShop({ tag: "b" });
    const c = await code(() => placeOrder(a, { items: [{ productId: b.product.id, quantity: 1 }] }));
    expect(c).toBe("BAD_REQUEST");
    expect(await db.order.count()).toBe(0);
  });

  it("rejects unavailable and archived products", async () => {
    const shop = await makeShop();
    await db.product.update({ where: { id: shop.product.id }, data: { isAvailable: false } });
    expect(await code(() => placeOrder(shop))).toBe("BAD_REQUEST");
    await db.product.update({ where: { id: shop.product.id }, data: { isAvailable: true } });
    await archiveProduct(shop.ctx, { id: shop.product.id });
    expect(await code(() => placeOrder(shop))).toBe("BAD_REQUEST");
    expect(await db.order.count()).toBe(0);
  });

  it("rejects quantity above tracked stock but does not decrement stock at creation", async () => {
    const shop = await makeShop();
    const p = (await createProduct(shop.ctx, { businessId: shop.business.id, name: "Limited", priceMinor: 5000 })) as { id: string };
    await db.product.update({ where: { id: p.id }, data: { trackInventory: true, stockQty: 2 } });
    expect(await code(() => placeOrder(shop, { items: [{ productId: p.id, quantity: 3 }] }))).toBe("BAD_REQUEST");
    await placeOrder(shop, { items: [{ productId: p.id, quantity: 2 }] });
    expect((await db.product.findUniqueOrThrow({ where: { id: p.id } })).stockQty).toBe(2);
  });

  it("rejects an inactive or suspended business and a suspended client", async () => {
    const shop = await makeShop();
    await db.business.update({ where: { id: shop.business.id }, data: { status: "SUSPENDED" } });
    expect(await code(() => placeOrder(shop))).toBe("BAD_REQUEST");
    await db.business.update({ where: { id: shop.business.id }, data: { status: "ACTIVE" } });
    await db.client.update({ where: { id: shop.client.id }, data: { status: "SUSPENDED" } });
    expect(await code(() => placeOrder(shop))).toBe("BAD_REQUEST");
    expect(await db.order.count()).toBe(0);
  });

  it("rejects when the business is not accepting orders", async () => {
    const shop = await makeShop();
    await db.business.update({ where: { id: shop.business.id }, data: { acceptingOrders: false } });
    expect(await code(() => placeOrder(shop))).toBe("BAD_REQUEST");
  });

  it("rejects revoked and expired QR codes and unknown tokens", async () => {
    const shop = await makeShop();
    expect(await code(() => placeOrder({ ...shop, qrToken: "doesnotexist12345" }))).toBe("NOT_FOUND");

    await db.qrCode.update({ where: { id: shop.qrId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await placeOrder(shop).catch((e) => e);
    expect(expired.code).toBe("BAD_REQUEST");
    expect(expired.details?.reason).toBe("QR_EXPIRED");
    await db.qrCode.update({ where: { id: shop.qrId }, data: { expiresAt: null } });

    await revokeQr(shop.ctx, { id: shop.qrId, reason: "lost sticker" });
    const revoked = await placeOrder(shop).catch((e) => e);
    expect(revoked.code).toBe("BAD_REQUEST");
    expect(revoked.details?.reason).toBe("QR_INACTIVE");
    expect(await db.order.count()).toBe(0);
  });

  it("requires a QR token or business code, and rejects a business code that does not match the QR", async () => {
    const a = await makeShop({ tag: "a" });
    const b = await makeShop({ tag: "b" });
    expect(await code(() => createOrder(customerCtx(), { items: [{ productId: a.product.id, quantity: 1 }], idempotencyKey: idemKey() }))).toBe("BAD_REQUEST");
    expect(
      await code(() => createOrder(customerCtx(), { qrToken: a.qrToken, businessCode: b.business.id, items: [{ productId: a.product.id, quantity: 1 }], idempotencyKey: idemKey() })),
    ).toBe("BAD_REQUEST");
  });

  it("enforces custom amount bounds on a dynamic payment QR", async () => {
    const shop = await makeShop();
    const dyn = (await createQr(shop.ctx, {
      businessId: shop.business.id,
      type: "DYNAMIC_PAYMENT",
      label: "Pay any amount",
      allowCustomAmount: true,
      minAmountMinor: 1000,
      maxAmountMinor: 50000,
    })) as { token: string };
    const make = (customAmountMinor: unknown) =>
      createOrder(customerCtx(), { qrToken: dyn.token, items: [], customAmountMinor, customer: {}, idempotencyKey: idemKey() });
    expect(await code(() => make(999))).toBe("BAD_REQUEST");
    expect(await code(() => make(50001))).toBe("BAD_REQUEST");
    expect(await code(() => make(0))).not.toBe("NO_ERROR");
    expect(await code(() => make(-5))).not.toBe("NO_ERROR");
    expect(await code(() => make(12.5))).not.toBe("NO_ERROR");
    expect((await make(1000)).totalMinor).toBe(1000);
    expect((await make(50000)).totalMinor).toBe(50000);
  });

  it("rejects a custom amount when neither the QR nor the business allows it", async () => {
    const shop = await makeShop();
    const c = await code(() => createOrder(customerCtx(), { qrToken: shop.qrToken, items: [], customAmountMinor: 5000, customer: {}, idempotencyKey: idemKey() }));
    expect(c).not.toBe("NO_ERROR");
    expect(await db.order.count()).toBe(0);
  });

  it("uses the fixed amount of a QR and refuses a client supplied amount", async () => {
    const shop = await makeShop();
    const fixed = (await createQr(shop.ctx, { businessId: shop.business.id, type: "DYNAMIC_PAYMENT", label: "Fixed 250", fixedAmountMinor: 25000 })) as { token: string };
    expect(await code(() => createOrder(customerCtx(), { qrToken: fixed.token, items: [], customAmountMinor: 100, customer: {}, idempotencyKey: idemKey() }))).toBe("BAD_REQUEST");
    const o = await createOrder(customerCtx(), { qrToken: fixed.token, items: [], customer: {}, idempotencyKey: idemKey() });
    expect(o.totalMinor).toBe(25000);
  });

  it("is idempotent per (business, idempotencyKey): one order, replayed flag, same total", async () => {
    const shop = await makeShop();
    const key = idemKey("same");
    const first = await placeOrder(shop, { idempotencyKey: key });
    const second = await placeOrder(shop, { idempotencyKey: key });
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.orderId).toBe(first.orderId);
    expect(second.publicId).toBe(first.publicId);
    expect(await db.order.count()).toBe(1);
    const other = await placeOrder(shop, { idempotencyKey: idemKey("diff") });
    expect(other.orderId).not.toBe(first.orderId);
  });

  it("concurrent creates with one key yield a single order", async () => {
    const shop = await makeShop();
    const key = idemKey("race");
    const rs = await Promise.allSettled([1, 2, 3].map(() => placeOrder(shop, { idempotencyKey: key })));
    const ok = rs.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof placeOrder>>>[];
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map((r) => r.value.orderId)).size).toBe(1);
    expect(await db.order.count()).toBe(1);
  });

  it("rejects malformed idempotency keys", async () => {
    const shop = await makeShop();
    expect(await code(() => placeOrder(shop, { idempotencyKey: "short" }))).toBe("VALIDATION");
    expect(await code(() => placeOrder(shop, { idempotencyKey: "has spaces and ;;; symbols" }))).toBe("VALIDATION");
  });

  it("rate limits order creation per IP", async () => {
    const shop = await makeShop();
    const ip = "198.18.0.9";
    let limited = 0;
    for (let i = 0; i < 32; i++) {
      const c = await code(() => placeOrder(shop, {}, customerCtx(ip)));
      if (c === "RATE_LIMITED") limited++;
    }
    expect(limited).toBeGreaterThanOrEqual(1);
  });

  it("POST /api/pay/orders: public, prices server side, returns { data }", async () => {
    const shop = await makeShop({ priceMinor: 9900 });
    const r = await createOrderRoute(
      req("POST", "/api/pay/orders", { body: { qrToken: shop.qrToken, items: [{ productId: shop.product.id, quantity: 2, priceMinor: 1 }], customer: {}, idempotencyKey: idemKey() } }),
      seg({}),
    );
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.data.totalMinor).toBe(19800);
    expect(body.data.publicId).toBeTruthy();
  });

  it("POST /api/pay/orders with bad input returns the error shape", async () => {
    const r = await createOrderRoute(req("POST", "/api/pay/orders", { body: { items: "nope" } }), seg({}));
    expect(r.status).toBeGreaterThanOrEqual(400);
    const body = await r.json();
    expect(body.error.code).toBeTruthy();
    expect(body.error.message).toBeTruthy();
  });
});

describe("order listing, detail and cancel are tenant scoped", () => {
  it("client sees only its own orders; foreign order id gives NOT_FOUND", async () => {
    const a = await makeShop({ tag: "a" });
    const b = await makeShop({ tag: "b" });
    const oa = await placeOrder(a);
    const ob = await placeOrder(b);

    const listA = await listOrders(a.ctx, {});
    expect(listA.items.map((o: { id: string }) => o.id)).toEqual([oa.orderId]);

    expect(await code(() => getOrder(a.ctx, ob.orderId))).toBe("NOT_FOUND");
    expect(await code(() => cancelOrder(a.ctx, { orderId: ob.orderId }))).toBe("NOT_FOUND");
    expect((await db.order.findUniqueOrThrow({ where: { id: ob.orderId } })).status).toBe("PENDING_PAYMENT");

    const r = await clientOrderRoute(req("GET", `/api/client/orders/${ob.orderId}`, { cookie: a.cookie }), seg({ id: ob.orderId }));
    expect(r.status).toBe(404);
    const r2 = await clientOrdersRoute(req("GET", "/api/client/orders", { cookie: a.cookie }), seg({}));
    expect(r2.status).toBe(200);
    expect(JSON.stringify(await r2.json())).not.toContain(ob.orderId);
  });

  it("requires payments.view to list and orders.manage to cancel", async () => {
    const shop = await makeShop({ permissions: ["qr.manage", "products.manage"] });
    const o = await placeOrder(shop);
    expect(await code(() => listOrders(shop.ctx, {}))).toBe("FORBIDDEN");
    const viewer = await makeShop({ tag: "v", permissions: ["qr.manage", "products.manage", "payments.view"] });
    const ov = await placeOrder(viewer);
    expect(await code(() => cancelOrder(viewer.ctx, { orderId: ov.orderId }))).toBe("FORBIDDEN");
    expect(o.orderId).toBeTruthy();
  });

  it("unauthenticated list is rejected", async () => {
    const r = await clientOrdersRoute(req("GET", "/api/client/orders"), seg({}));
    expect(r.status).toBe(401);
  });

  it("cancelling a pending order marks it CANCELLED and audits; a second cancel conflicts", async () => {
    const shop = await makeShop();
    const o = await placeOrder(shop);
    await cancelOrder(shop.ctx, { orderId: o.orderId });
    expect((await db.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe("CANCELLED");
    expect(await db.auditLog.count({ where: { action: "order.cancel", entityId: o.orderId } })).toBe(1);
    expect(await code(() => cancelOrder(shop.ctx, { orderId: o.orderId }))).toBe("CONFLICT");
  });

  it("admin sees orders across tenants", async () => {
    const a = await makeShop({ tag: "a" });
    const b = await makeShop({ tag: "b" });
    await placeOrder(a);
    await placeOrder(b);
    const admin = await makeAdminSession();
    const list = await listOrders(admin.ctx, {});
    expect(list.items.length).toBe(2);
  });
});
