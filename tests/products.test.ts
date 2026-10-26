import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { createCategory, deleteCategory, listCategories, updateCategory } from "@/server/services/categories";
import { archiveProduct, createProduct, deleteProduct, getProduct, listProducts, restoreProduct, setProductAvailability, updateProduct } from "@/server/services/products";
import { createOffer, deleteOffer, findOfferByCode, listOffers, updateOffer } from "@/server/services/offers";
import { detectImageType, saveProductImage } from "@/server/services/files";
import { anonCtx, resetDb } from "./helpers";
import { JPEG_BYTES, makeAdminSession, makeOrder, makeTenant, PNG_BYTES, req, seg, WEBP_BYTES, addBusiness } from "./helpers-catalog";

import { GET as filesGET } from "@/app/api/files/[id]/route";
import { GET as clientProductsGET, POST as clientProductsPOST } from "@/app/api/client/products/route";
import { GET as adminProductsGET } from "@/app/api/admin/products/route";
import { POST as clientImagePOST } from "@/app/api/client/products/image/route";
import { PATCH as clientProductPATCH } from "@/app/api/client/products/[id]/route";

async function code(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
  return "NO_ERROR";
}

const widget = (businessId: string, extra: Record<string, unknown> = {}) => ({ businessId, name: "Widget", priceMinor: 10000, ...extra });

beforeEach(async () => {
  await resetDb();
});

describe("categories", () => {
  it("creates, lists, renames and deletes within a business; duplicate names conflict", async () => {
    const a = await makeTenant();
    const c = await createCategory(a.ctx, { businessId: a.business.id, name: "Drinks" });
    expect(await code(() => createCategory(a.ctx, { businessId: a.business.id, name: "Drinks" }))).toBe("CONFLICT");
    const renamed = await updateCategory(a.ctx, { id: c.id, name: "Beverages", sortOrder: 2 });
    expect(renamed.name).toBe("Beverages");
    await createProduct(a.ctx, widget(a.business.id, { categoryId: c.id }));
    const list = await listCategories(a.ctx, {});
    expect(list).toHaveLength(1);
    expect(list[0].productCount).toBe(1);
    const del = await deleteCategory(a.ctx, { id: c.id });
    expect(del.productsUncategorised).toBe(1);
    const p = await db.product.findFirstOrThrow();
    expect(p.categoryId).toBeNull();
  });

  it("rejects empty and over-long names", async () => {
    const a = await makeTenant();
    expect(await code(() => createCategory(a.ctx, { businessId: a.business.id, name: "   " }))).toBe("VALIDATION");
    expect(await code(() => createCategory(a.ctx, { businessId: a.business.id, name: "x".repeat(61) }))).toBe("VALIDATION");
  });

  it("hides another client's categories as 404 and blocks creating in their business", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const cb = await createCategory(b.ctx, { businessId: b.business.id, name: "Secret" });
    expect(await code(() => updateCategory(a.ctx, { id: cb.id, name: "Hacked" }))).toBe("NOT_FOUND");
    expect(await code(() => deleteCategory(a.ctx, { id: cb.id }))).toBe("NOT_FOUND");
    expect(await code(() => createCategory(a.ctx, { businessId: b.business.id, name: "Mine now" }))).toBe("NOT_FOUND");
    expect(await code(() => listCategories(a.ctx, { businessId: b.business.id }))).toBe("NOT_FOUND");
    expect(await listCategories(a.ctx, {})).toHaveLength(0);
    expect((await db.productCategory.findUniqueOrThrow({ where: { id: cb.id } })).name).toBe("Secret");
  });
});

describe("products: CRUD and validation", () => {
  it("creates a product with defaults, reads it back, updates and audits", async () => {
    const a = await makeTenant();
    const p = await createProduct(a.ctx, widget(a.business.id, { sku: "W-1", description: "A widget" }));
    expect(p.priceMinor).toBe(10000);
    expect(p.kind).toBe("PRODUCT");
    expect(p.isAvailable).toBe(true);
    expect(p.discountType).toBe("NONE");
    const u = await updateProduct(a.ctx, { id: p.id, name: "Widget 2", priceMinor: 12500, taxBps: 1800, discountType: "PERCENT", discountValue: 1000 });
    expect(u.name).toBe("Widget 2");
    expect(u.taxBps).toBe(1800);
    const got = await getProduct(a.ctx, { id: p.id });
    expect(got.priceMinor).toBe(12500);
    const audits = await db.auditLog.findMany({ where: { entityId: p.id }, orderBy: { createdAt: "asc" } });
    expect(audits.map((x) => x.action)).toEqual(["product.create", "product.update"]);
  });

  it("rejects bad prices, tax, discounts and names", async () => {
    const a = await makeTenant();
    const bid = a.business.id;
    for (const bad of [0, -5, 1.5, 10_000_000_01]) {
      expect(await code(() => createProduct(a.ctx, widget(bid, { priceMinor: bad })))).toBe("VALIDATION");
    }
    expect(await code(() => createProduct(a.ctx, widget(bid, { priceMinor: "100" })))).toBe("VALIDATION");
    expect(await code(() => createProduct(a.ctx, widget(bid, { taxBps: 10001 })))).toBe("VALIDATION");
    expect(await code(() => createProduct(a.ctx, widget(bid, { taxBps: -1 })))).toBe("VALIDATION");
    expect(await code(() => createProduct(a.ctx, widget(bid, { name: "" })))).toBe("VALIDATION");
    expect(await code(() => createProduct(a.ctx, widget(bid, { discountType: "PERCENT", discountValue: 10001 })))).toBe("VALIDATION");
    expect(await code(() => createProduct(a.ctx, widget(bid, { discountType: "FIXED", discountValue: 10001 })))).toBe("VALIDATION");
    expect(await code(() => createProduct(a.ctx, widget(bid, { kind: "GADGET" })))).toBe("VALIDATION");
    expect(await db.product.count()).toBe(0);
    // boundaries that are valid
    expect((await createProduct(a.ctx, widget(bid, { name: "Max", priceMinor: 10_000_000_00, taxBps: 10000 }))).priceMinor).toBe(10_000_000_00);
    expect((await createProduct(a.ctx, widget(bid, { name: "Free tax", taxBps: 0, discountType: "FIXED", discountValue: 10000 }))).taxBps).toBe(0);
  });

  it("validates discount against the new price on update", async () => {
    const a = await makeTenant();
    const p = await createProduct(a.ctx, widget(a.business.id, { discountType: "FIXED", discountValue: 5000 }));
    expect(await code(() => updateProduct(a.ctx, { id: p.id, priceMinor: 4000 }))).toBe("VALIDATION");
    expect((await getProduct(a.ctx, { id: p.id })).priceMinor).toBe(10000);
  });

  it("enforces unique SKU per business among live products", async () => {
    const a = await makeTenant();
    const p1 = await createProduct(a.ctx, widget(a.business.id, { sku: "SKU-1" }));
    expect(await code(() => createProduct(a.ctx, widget(a.business.id, { name: "Other", sku: "sku-1" })))).toBe("CONFLICT");
    // an archived product frees its SKU
    await archiveProduct(a.ctx, { id: p1.id });
    expect((await createProduct(a.ctx, widget(a.business.id, { name: "Other", sku: "SKU-1" }))).sku).toBe("SKU-1");
    // the same SKU in a different business is fine
    const b = await makeTenant();
    expect((await createProduct(b.ctx, widget(b.business.id, { sku: "SKU-1" }))).sku).toBe("SKU-1");
  });

  it("accepts a category only from the same business", async () => {
    const a = await makeTenant();
    const second = await addBusiness(a, "Second shop");
    const catA = await createCategory(a.ctx, { businessId: a.business.id, name: "Mains" });
    const catSecond = await createCategory(a.ctx, { businessId: second.id, name: "Other" });
    expect((await createProduct(a.ctx, widget(a.business.id, { categoryId: catA.id }))).categoryId).toBe(catA.id);
    // category from a different business of the same client
    expect(await code(() => createProduct(a.ctx, widget(a.business.id, { name: "X", categoryId: catSecond.id })))).toBe("NOT_FOUND");
    // category from another client entirely
    const b = await makeTenant();
    const catB = await createCategory(b.ctx, { businessId: b.business.id, name: "Theirs" });
    expect(await code(() => createProduct(a.ctx, widget(a.business.id, { name: "Y", categoryId: catB.id })))).toBe("NOT_FOUND");
    const p = await createProduct(a.ctx, widget(a.business.id, { name: "Z" }));
    expect(await code(() => updateProduct(a.ctx, { id: p.id, categoryId: catB.id }))).toBe("NOT_FOUND");
    expect(await db.product.count({ where: { categoryId: catB.id } })).toBe(0);
  });

  it("rejects an image id that is not an image file", async () => {
    const a = await makeTenant();
    expect(await code(() => createProduct(a.ctx, widget(a.business.id, { imageFileId: "does-not-exist" })))).toBe("NOT_FOUND");
    const f = await db.fileAsset.create({ data: { contentType: "text/html", size: 3, sha256: "x", data: Buffer.from("abc") } });
    expect(await code(() => createProduct(a.ctx, widget(a.business.id, { imageFileId: f.id })))).toBe("NOT_FOUND");
    const img = await saveProductImage({ userId: a.user.id }, PNG_BYTES());
    const p = await createProduct(a.ctx, widget(a.business.id, { imageFileId: img.id }));
    expect(p.imageUrl).toBe(`/api/files/${img.id}`);
  });

  it("toggles availability, archives and restores; archived products leave the default list", async () => {
    const a = await makeTenant();
    const p = await createProduct(a.ctx, widget(a.business.id));
    expect((await setProductAvailability(a.ctx, { id: p.id, isAvailable: false })).isAvailable).toBe(false);
    expect(await code(() => setProductAvailability(a.ctx, { id: p.id, isAvailable: "no" }))).toBe("VALIDATION");
    await archiveProduct(a.ctx, { id: p.id });
    expect((await listProducts(a.ctx, {})).items).toHaveLength(0);
    expect((await listProducts(a.ctx, { status: "archived" })).items).toHaveLength(1);
    await restoreProduct(a.ctx, { id: p.id });
    expect((await listProducts(a.ctx, {})).items).toHaveLength(1);
  });

  it("deleteProduct hard-deletes unused products and archives those referenced by orders", async () => {
    const a = await makeTenant();
    const unused = await createProduct(a.ctx, widget(a.business.id, { name: "Unused" }));
    const used = await createProduct(a.ctx, widget(a.business.id, { name: "Used" }));
    const order = await makeOrder({ businessId: a.business.id, totalMinor: 10000, paid: false });
    await db.orderItem.create({ data: { orderId: order.id, productId: used.id, name: "Used", unitPriceMinor: 10000, quantity: 1, lineTotalMinor: 10000 } });
    expect(await deleteProduct(a.ctx, { id: unused.id })).toMatchObject({ deleted: true });
    expect(await db.product.findUnique({ where: { id: unused.id } })).toBeNull();
    expect(await deleteProduct(a.ctx, { id: used.id })).toMatchObject({ deleted: false, archived: true });
    const row = await db.product.findUniqueOrThrow({ where: { id: used.id } });
    expect(row.archivedAt).not.toBeNull();
    expect(row.isAvailable).toBe(false);
    expect(await db.orderItem.count({ where: { productId: used.id } })).toBe(1);
  });

  it("lists with search, category, status, pagination", async () => {
    const a = await makeTenant();
    const cat = await createCategory(a.ctx, { businessId: a.business.id, name: "Food" });
    for (let i = 1; i <= 12; i++) await createProduct(a.ctx, widget(a.business.id, { name: `Item ${String(i).padStart(2, "0")}`, categoryId: i <= 3 ? cat.id : null }));
    await createProduct(a.ctx, widget(a.business.id, { name: "Samosa", isAvailable: false }));
    const all = await listProducts(a.ctx, { pageSize: 5 });
    expect(all.total).toBe(13);
    expect(all.items).toHaveLength(5);
    expect((await listProducts(a.ctx, { q: "samo" })).items.map((x) => x.name)).toEqual(["Samosa"]);
    expect((await listProducts(a.ctx, { categoryId: cat.id })).total).toBe(3);
    expect((await listProducts(a.ctx, { categoryId: "none" })).total).toBe(10);
    expect((await listProducts(a.ctx, { status: "unavailable" })).total).toBe(1);
    expect((await listProducts(a.ctx, { status: "available" })).total).toBe(12);
    expect(await code(() => listProducts(a.ctx, { status: "bogus" }))).toBe("VALIDATION");
  });
});

describe("products: tenant isolation and permissions", () => {
  it("client A cannot read, change, archive or delete client B's product (404), and cannot create in B's business", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const pb = await createProduct(b.ctx, widget(b.business.id, { name: "B product" }));
    expect(await code(() => getProduct(a.ctx, { id: pb.id }))).toBe("NOT_FOUND");
    expect(await code(() => updateProduct(a.ctx, { id: pb.id, name: "Hacked" }))).toBe("NOT_FOUND");
    expect(await code(() => setProductAvailability(a.ctx, { id: pb.id, isAvailable: false }))).toBe("NOT_FOUND");
    expect(await code(() => archiveProduct(a.ctx, { id: pb.id }))).toBe("NOT_FOUND");
    expect(await code(() => restoreProduct(a.ctx, { id: pb.id }))).toBe("NOT_FOUND");
    expect(await code(() => deleteProduct(a.ctx, { id: pb.id }))).toBe("NOT_FOUND");
    expect(await code(() => createProduct(a.ctx, widget(b.business.id)))).toBe("NOT_FOUND");
    expect(await code(() => listProducts(a.ctx, { businessId: b.business.id }))).toBe("NOT_FOUND");
    expect((await listProducts(a.ctx, {})).items).toHaveLength(0);
    const row = await db.product.findUniqueOrThrow({ where: { id: pb.id } });
    expect(row.name).toBe("B product");
    expect(row.archivedAt).toBeNull();
  });

  it("a client user only sees businesses they are a member of", async () => {
    const a = await makeTenant();
    const sibling = await db.business.create({ data: { businessCode: "BZ-SIBLING1", clientId: a.client.id, name: "Not mine", category: "retail", status: "ACTIVE" } });
    await db.product.create({ data: { businessId: sibling.id, name: "Hidden", priceMinor: 100 } });
    expect((await listProducts(a.ctx, {})).items).toHaveLength(0);
    expect(await code(() => createProduct(a.ctx, widget(sibling.id)))).toBe("NOT_FOUND");
  });

  it("refuses everything without products.manage / offers.manage, and for anonymous callers", async () => {
    const a = await makeTenant({ permissions: ["qr.manage"] });
    const admin = await makeAdminSession();
    const p = await createProduct(admin.ctx, widget(a.business.id));
    expect(await code(() => createProduct(a.ctx, widget(a.business.id)))).toBe("FORBIDDEN");
    expect(await code(() => listProducts(a.ctx, {}))).toBe("FORBIDDEN");
    expect(await code(() => getProduct(a.ctx, { id: p.id }))).toBe("FORBIDDEN");
    expect(await code(() => updateProduct(a.ctx, { id: p.id, name: "x" }))).toBe("FORBIDDEN");
    expect(await code(() => archiveProduct(a.ctx, { id: p.id }))).toBe("FORBIDDEN");
    expect(await code(() => deleteProduct(a.ctx, { id: p.id }))).toBe("FORBIDDEN");
    expect(await code(() => createCategory(a.ctx, { businessId: a.business.id, name: "c" }))).toBe("FORBIDDEN");
    expect(await code(() => listCategories(a.ctx, {}))).toBe("FORBIDDEN");
    expect(await code(() => createOffer(a.ctx, { businessId: a.business.id, title: "Off", code: "OFFER10", type: "PERCENT", value: 1000 }))).toBe("FORBIDDEN");
    expect(await code(() => listOffers(a.ctx, {}))).toBe("FORBIDDEN");
    expect(await code(() => listProducts(anonCtx(), {}))).toBe("UNAUTHENTICATED");
    expect(await code(() => createProduct(anonCtx(), widget(a.business.id)))).toBe("UNAUTHENTICATED");
    // products.manage alone does not grant offers
    const c = await makeTenant({ permissions: ["products.manage"] });
    expect((await createProduct(c.ctx, widget(c.business.id))).name).toBe("Widget");
    expect(await code(() => listOffers(c.ctx, {}))).toBe("FORBIDDEN");
  });

  it("admin manages any business and the list spans businesses with a business filter", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const admin = await makeAdminSession();
    await createProduct(admin.ctx, widget(a.business.id, { name: "In A" }));
    await createProduct(admin.ctx, widget(b.business.id, { name: "In B" }));
    expect((await listProducts(admin.ctx, {})).total).toBe(2);
    expect((await listProducts(admin.ctx, { businessId: b.business.id })).items.map((x) => x.name)).toEqual(["In B"]);
    expect(await code(() => createProduct(admin.ctx, widget("no-such-business")))).toBe("NOT_FOUND");
  });
});

describe("offers", () => {
  const offer = (businessId: string, extra: Record<string, unknown> = {}) => ({ businessId, title: "Ten off", code: "save10", type: "PERCENT", value: 1000, ...extra });

  it("stores the code uppercase, enforces uniqueness per business, finds by code", async () => {
    const a = await makeTenant();
    const o = await createOffer(a.ctx, offer(a.business.id, { minOrderMinor: 50000, maxDiscountMinor: 20000, usageLimit: 5 }));
    expect(o.code).toBe("SAVE10");
    expect(await code(() => createOffer(a.ctx, offer(a.business.id, { code: " Save10 " })))).toBe("CONFLICT");
    const found = await findOfferByCode(a.business.id, "save10");
    expect(found?.id).toBe(o.id);
    expect(await findOfferByCode(a.business.id, "nope")).toBeNull();
    // the same code in another business is fine
    const b = await makeTenant();
    expect((await createOffer(b.ctx, offer(b.business.id))).code).toBe("SAVE10");
    expect(await findOfferByCode(b.business.id, "SAVE10")).not.toBeNull();
  });

  it("rejects invalid codes, values, windows and limits", async () => {
    const a = await makeTenant();
    const id = a.business.id;
    expect(await code(() => createOffer(a.ctx, offer(id, { code: "a" })))).toBe("VALIDATION");
    expect(await code(() => createOffer(a.ctx, offer(id, { code: "has space" })))).toBe("VALIDATION");
    expect(await code(() => createOffer(a.ctx, offer(id, { code: "x".repeat(25) })))).toBe("VALIDATION");
    expect(await code(() => createOffer(a.ctx, offer(id, { value: 0 })))).toBe("VALIDATION");
    expect(await code(() => createOffer(a.ctx, offer(id, { value: 10001 })))).toBe("VALIDATION");
    expect(await code(() => createOffer(a.ctx, offer(id, { type: "BOGO" })))).toBe("VALIDATION");
    expect(await code(() => createOffer(a.ctx, offer(id, { usageLimit: 0 })))).toBe("VALIDATION");
    expect(await code(() => createOffer(a.ctx, offer(id, { minOrderMinor: -1 })))).toBe("VALIDATION");
    expect(await code(() => createOffer(a.ctx, offer(id, { validFrom: "2030-02-01", validTo: "2030-01-01" })))).toBe("VALIDATION");
    expect(await code(() => createOffer(a.ctx, offer(id, { validFrom: "not a date" })))).toBe("VALIDATION");
    expect(await db.offer.count()).toBe(0);
    // a FIXED offer may exceed 10000 (minor units)
    expect((await createOffer(a.ctx, offer(id, { type: "FIXED", value: 50000 }))).value).toBe(50000);
  });

  it("updates, refuses a usage limit below the used count, and filters by status", async () => {
    const a = await makeTenant();
    const o = await createOffer(a.ctx, offer(a.business.id, { usageLimit: 10 }));
    await db.offer.update({ where: { id: o.id }, data: { usedCount: 4 } });
    expect(await code(() => updateOffer(a.ctx, { id: o.id, usageLimit: 3 }))).toBe("VALIDATION");
    expect((await updateOffer(a.ctx, { id: o.id, usageLimit: 4, isActive: false })).isActive).toBe(false);
    await createOffer(a.ctx, offer(a.business.id, { code: "LIVE", title: "Live" }));
    await createOffer(a.ctx, offer(a.business.id, { code: "OLD", title: "Old", validFrom: "2020-01-01", validTo: "2020-02-01" }));
    expect((await listOffers(a.ctx, { status: "active" })).items.map((x) => x.code)).toEqual(["LIVE"]);
    expect((await listOffers(a.ctx, { status: "inactive" })).items.map((x) => x.code)).toEqual(["SAVE10"]);
    expect((await listOffers(a.ctx, { status: "expired" })).items.map((x) => x.code)).toEqual(["OLD"]);
    expect((await listOffers(a.ctx, {})).total).toBe(3);
  });

  it("deleteOffer removes unused offers and deactivates ones that orders used", async () => {
    const a = await makeTenant();
    const unused = await createOffer(a.ctx, offer(a.business.id, { code: "UNUSED" }));
    const used = await createOffer(a.ctx, offer(a.business.id, { code: "USED" }));
    const order = await makeOrder({ businessId: a.business.id, totalMinor: 9000, paid: false });
    await db.order.update({ where: { id: order.id }, data: { offerId: used.id } });
    expect(await deleteOffer(a.ctx, { id: unused.id })).toMatchObject({ deleted: true });
    expect(await deleteOffer(a.ctx, { id: used.id })).toMatchObject({ deleted: false, deactivated: true });
    expect((await db.offer.findUniqueOrThrow({ where: { id: used.id } })).isActive).toBe(false);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).offerId).toBe(used.id);
  });

  it("is tenant isolated: another client's offers are 404", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const ob = await createOffer(b.ctx, offer(b.business.id));
    expect(await code(() => updateOffer(a.ctx, { id: ob.id, title: "Hacked" }))).toBe("NOT_FOUND");
    expect(await code(() => deleteOffer(a.ctx, { id: ob.id }))).toBe("NOT_FOUND");
    expect(await code(() => createOffer(a.ctx, offer(b.business.id, { code: "STEAL" })))).toBe("NOT_FOUND");
    expect(await code(() => listOffers(a.ctx, { businessId: b.business.id }))).toBe("NOT_FOUND");
    expect((await listOffers(a.ctx, {})).items).toHaveLength(0);
    expect((await db.offer.findUniqueOrThrow({ where: { id: ob.id } })).title).toBe("Ten off");
  });
});

describe("files and image upload", () => {
  it("detects png, jpeg and webp by magic bytes only", () => {
    expect(detectImageType(PNG_BYTES())).toBe("image/png");
    expect(detectImageType(JPEG_BYTES())).toBe("image/jpeg");
    expect(detectImageType(WEBP_BYTES())).toBe("image/webp");
    expect(detectImageType(Buffer.from("GIF89a-not-allowed"))).toBeNull();
    expect(detectImageType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"))).toBeNull();
    expect(detectImageType(Buffer.from("RIFF....WAVE"))).toBeNull();
  });

  it("saveProductImage rejects wrong magic bytes, empty and oversize files; stores nothing", async () => {
    const a = await makeTenant();
    const actor = { userId: a.user.id };
    expect(await code(() => saveProductImage(actor, Buffer.from("<html><script>alert(1)</script></html>")))).toBe("VALIDATION");
    expect(await code(() => saveProductImage(actor, Buffer.alloc(0)))).toBe("VALIDATION");
    const big = Buffer.concat([PNG_BYTES(), Buffer.alloc(1024 * 1024)]);
    expect(await code(() => saveProductImage(actor, big))).toBe("VALIDATION");
    expect(await db.fileAsset.count()).toBe(0);
    const exactly = Buffer.concat([PNG_BYTES(), Buffer.alloc(1024 * 1024 - PNG_BYTES().length)]);
    expect(exactly.length).toBe(1024 * 1024);
    expect((await saveProductImage(actor, exactly)).size).toBe(1024 * 1024);
  });

  it("POST /api/client/products/image: stores a valid image, rejects bad bytes, oversize, non-multipart, no permission and anon", async () => {
    const a = await makeTenant();
    const post = (cookie: string | undefined, bytes: Buffer, name = "p.png", type = "image/png") => {
      const form = new FormData();
      form.set("file", new File([new Uint8Array(bytes)], name, { type }));
      return clientImagePOST(req("POST", "/api/client/products/image", { cookie, form }), seg({}));
    };
    const ok = await post(a.cookie, PNG_BYTES());
    expect(ok.status).toBe(200);
    const okBody = await ok.json();
    expect(okBody.data.contentType).toBe("image/png");
    expect(okBody.data.url).toBe(`/api/files/${okBody.data.id}`);

    // a file claiming to be PNG whose bytes are HTML
    const fake = await post(a.cookie, Buffer.from("<html></html>"));
    expect(fake.status).toBe(422);
    expect((await fake.json()).error.code).toBe("VALIDATION");
    const oversize = await post(a.cookie, Buffer.concat([PNG_BYTES(), Buffer.alloc(1024 * 1024)]));
    expect(oversize.status).toBe(422);

    const json = await clientImagePOST(req("POST", "/api/client/products/image", { cookie: a.cookie, body: { x: 1 } }), seg({}));
    expect(json.status).toBe(400);
    expect((await post(undefined, PNG_BYTES())).status).toBe(401);
    const noPerm = await makeTenant({ permissions: ["qr.manage"] });
    expect((await post(noPerm.cookie, PNG_BYTES())).status).toBe(403);
    expect(await db.fileAsset.count()).toBe(1);
    expect(await db.auditLog.count({ where: { action: "file.upload" } })).toBe(1);
  });

  it("GET /api/files/:id serves hardened headers, ETag 304, and 404 for unknown ids; no session needed", async () => {
    const a = await makeTenant();
    const saved = await saveProductImage({ userId: a.user.id }, JPEG_BYTES());
    const res = await filesGET(req("GET", `/api/files/${saved.id}`), seg({ id: saved.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect(res.headers.get("cache-control")).toContain("max-age=31536000");
    const etag = res.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(Buffer.from(await res.arrayBuffer()).equals(JPEG_BYTES())).toBe(true);

    const notModified = await filesGET(req("GET", `/api/files/${saved.id}`, { headers: { "if-none-match": etag } }), seg({ id: saved.id }));
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("etag")).toBe(etag);
    const stale = await filesGET(req("GET", `/api/files/${saved.id}`, { headers: { "if-none-match": '"other"' } }), seg({ id: saved.id }));
    expect(stale.status).toBe(200);

    const missing = await filesGET(req("GET", "/api/files/nope"), seg({ id: "nope" }));
    expect(missing.status).toBe(404);
  });
});

describe("product routes", () => {
  it("client routes: list/create/patch work for the owner; cross-tenant patch is 404; admin cannot use client route; client cannot use admin route", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const admin = await makeAdminSession();

    const created = await clientProductsPOST(req("POST", "/api/client/products", { cookie: a.cookie, body: widget(a.business.id) }), seg({}));
    expect(created.status).toBe(200);
    const id = (await created.json()).data.id as string;
    const list = await clientProductsGET(req("GET", "/api/client/products", { cookie: a.cookie }), seg({}));
    expect((await list.json()).data.total).toBe(1);

    const patched = await clientProductPATCH(req("PATCH", `/api/client/products/${id}`, { cookie: a.cookie, body: { name: "Renamed" } }), seg({ id }));
    expect(patched.status).toBe(200);
    const cross = await clientProductPATCH(req("PATCH", `/api/client/products/${id}`, { cookie: b.cookie, body: { name: "Hacked" } }), seg({ id }));
    expect(cross.status).toBe(404);
    expect((await db.product.findUniqueOrThrow({ where: { id } })).name).toBe("Renamed");

    const bad = await clientProductsPOST(req("POST", "/api/client/products", { cookie: a.cookie, body: widget(a.business.id, { priceMinor: -1 }) }), seg({}));
    expect(bad.status).toBe(422);
    expect((await bad.json()).error.details.fields.priceMinor).toBeTruthy();

    const anon = await clientProductsGET(req("GET", "/api/client/products"), seg({}));
    expect(anon.status).toBe(401);
    const adminOnClient = await clientProductsGET(req("GET", "/api/client/products", { cookie: admin.cookie }), seg({}));
    expect(adminOnClient.status).toBe(403);
    const clientOnAdmin = await adminProductsGET(req("GET", "/api/admin/products", { cookie: a.cookie }), seg({}));
    expect(clientOnAdmin.status).toBe(403);
    const adminList = await adminProductsGET(req("GET", "/api/admin/products", { cookie: admin.cookie }), seg({}));
    expect(adminList.status).toBe(200);
    expect((await adminList.json()).data.total).toBe(1);
  });

  it("blocks cross-site state changes (CSRF)", async () => {
    const a = await makeTenant();
    const res = await clientProductsPOST(
      req("POST", "/api/client/products", { cookie: a.cookie, body: widget(a.business.id), headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } }),
      seg({}),
    );
    expect(res.status).toBe(403);
    expect(await db.product.count()).toBe(0);
  });
});
