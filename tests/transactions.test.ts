import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { csvCell, toCsv } from "@/server/services/csv";
import {
  exportTransactionsCsv,
  getTransaction,
  listTransactions,
  summarizeTransactions,
  transactionTotals,
  verifiedTxnWhere,
} from "@/server/services/transactions";
import { receiptData, receiptPdf } from "@/server/services/receipts";
import { requestRefund } from "@/server/services/refunds";
import { createProduct } from "@/server/services/products";
import { createQr } from "@/server/services/qr";
import { GET as adminList } from "@/app/api/admin/transactions/route";
import { GET as adminOne } from "@/app/api/admin/transactions/[id]/route";
import { GET as adminExport } from "@/app/api/admin/transactions/export/route";
import { GET as clientList } from "@/app/api/client/transactions/route";
import { GET as clientOne } from "@/app/api/client/transactions/[id]/route";
import { GET as clientExport } from "@/app/api/client/transactions/export/route";
import { GET as receiptGet } from "@/app/api/pay/[publicId]/receipt/route";
import { GET as receiptPdfGet } from "@/app/api/pay/[publicId]/receipt/pdf/route";
import { resetDb } from "./helpers";
import { addBusiness } from "./helpers-catalog";
import {
  PAY_PERMISSIONS,
  code,
  customerCtx,
  deliver,
  idemKey,
  makeAdminSession,
  makeShop,
  orderWithSimAttempt,
  paidOrder,
  placeOrder,
  req,
  seg,
  simulatorWebhook,
  type Shop,
} from "./helpers-payments";
import type { Ctx } from "@/server/auth/types";

const P = { params: Promise.resolve({}) } as never;

beforeEach(async () => {
  await resetDb();
});

/** Same actor, fewer permissions (as if the client account had only these features enabled). */
function withPermissions(ctx: Ctx, permissions: string[]): Ctx {
  return { ...ctx, actor: { ...ctx.actor!, permissions } };
}

describe("verifiedTxnWhere and summarizeTransactions", () => {
  it("sums gross, refunded, fee (fee + tax on fee) and net as integers", async () => {
    const shop = await makeShop({ priceMinor: 10000 });
    const a = await paidOrder(shop);
    const b = await paidOrder(shop);
    await db.paymentTransaction.update({ where: { id: a.txn.id }, data: { feeMinor: 236, feeTaxMinor: 42 } });
    await requestRefund(shop.ctx, { transactionId: b.txn.id, amountMinor: 2500, reason: "Partial return", idempotencyKey: idemKey("rf") });
    const s = await summarizeTransactions({ clientId: shop.client.id });
    expect(s.count).toBe(2);
    expect(s.grossMinor).toBe(20000);
    expect(s.refundedMinor).toBe(2500);
    expect(s.feeMinor).toBe(278);
    expect(s.netMinor).toBe(20000 - 2500 - 278);
    expect(Number.isInteger(s.netMinor)).toBe(true);
  });

  it("returns zeros when there is nothing, and zero for an empty businessIds list", async () => {
    const shop = await makeShop();
    await paidOrder(shop);
    expect(await summarizeTransactions({ clientId: "nope" })).toEqual({ count: 0, grossMinor: 0, refundedMinor: 0, feeMinor: 0, netMinor: 0 });
    expect((await summarizeTransactions({ businessIds: [] })).count).toBe(0);
    expect(await db.paymentTransaction.count({ where: verifiedTxnWhere({ businessIds: [] }) })).toBe(0);
  });

  it("excludes duplicate payments by default and includes them when asked", async () => {
    const shop = await makeShop({ priceMinor: 10000 });
    const { order, start } = await paidOrder(shop);
    // Second capture on the same, already paid order: recorded as a flagged duplicate.
    const w = simulatorWebhook({ providerOrderId: start.providerOrderId!, providerPaymentId: "sim_pay_second", amountMinor: order.totalMinor });
    await deliver("DEV_SIMULATOR", w);
    const dup = await db.paymentTransaction.findFirst({ where: { orderId: order.orderId, isDuplicate: true } });
    expect(dup).not.toBeNull();
    expect((await summarizeTransactions({ clientId: shop.client.id })).grossMinor).toBe(10000);
    expect((await summarizeTransactions({ clientId: shop.client.id, includeDuplicates: true })).grossMinor).toBe(20000);
    expect(await db.paymentTransaction.count({ where: verifiedTxnWhere({ clientId: shop.client.id }) })).toBe(1);
    expect(await db.paymentTransaction.count({ where: verifiedTxnWhere({ clientId: shop.client.id, includeDuplicates: true }) })).toBe(2);
  });

  it("does not count transactions of another client", async () => {
    const a = await makeShop({ tag: "a" });
    const b = await makeShop({ tag: "b", priceMinor: 5000 });
    await paidOrder(a);
    await paidOrder(b);
    expect((await summarizeTransactions({ clientId: a.client.id })).grossMinor).toBe(10000);
    expect((await summarizeTransactions({ clientId: b.client.id })).grossMinor).toBe(5000);
    expect((await summarizeTransactions({ businessIds: [a.business.id, b.business.id] })).count).toBe(2);
    expect((await summarizeTransactions()).count).toBe(2);
  });

  it("applies the date range (from inclusive, to exclusive) on verification time", async () => {
    const shop = await makeShop();
    const a = await paidOrder(shop);
    const b = await paidOrder(shop);
    await db.paymentTransaction.update({ where: { id: a.txn.id }, data: { verifiedAt: new Date("2026-01-10T10:00:00Z") } });
    await db.paymentTransaction.update({ where: { id: b.txn.id }, data: { verifiedAt: new Date("2026-02-10T10:00:00Z") } });
    const jan = { clientId: shop.client.id, from: new Date("2026-01-01T00:00:00Z"), to: new Date("2026-02-01T00:00:00Z") };
    expect((await summarizeTransactions(jan)).count).toBe(1);
    expect(await db.paymentTransaction.count({ where: verifiedTxnWhere(jan) })).toBe(1);
    expect((await summarizeTransactions({ clientId: shop.client.id, from: new Date("2026-02-10T10:00:00Z") })).count).toBe(1);
    expect((await summarizeTransactions({ clientId: shop.client.id, to: new Date("2026-02-10T10:00:00Z") })).count).toBe(1);
  });

  it("ignores payments that were never verified (pending order, no transaction)", async () => {
    const shop = await makeShop();
    await orderWithSimAttempt(shop);
    expect((await summarizeTransactions({ clientId: shop.client.id })).count).toBe(0);
  });
});

describe("listTransactions, getTransaction, totals: tenant scope and filters", () => {
  it("a client sees only its own transactions; admin sees all", async () => {
    const a = await makeShop({ tag: "a" });
    const b = await makeShop({ tag: "b" });
    const pa = await paidOrder(a);
    const pb = await paidOrder(b);
    const admin = await makeAdminSession();

    const mineA = await listTransactions(a.ctx, {});
    expect(mineA.items.map((t) => t.id)).toEqual([pa.txn.id]);
    const mineB = await listTransactions(b.ctx, {});
    expect(mineB.items.map((t) => t.id)).toEqual([pb.txn.id]);
    const all = await listTransactions(admin.ctx, {});
    expect(all.total).toBe(2);
  });

  it("the list rows carry fee and net and no secrets", async () => {
    const shop = await makeShop();
    const { txn } = await paidOrder(shop);
    await db.paymentTransaction.update({ where: { id: txn.id }, data: { feeMinor: 200, feeTaxMinor: 36 } });
    const page = await listTransactions(shop.ctx, {});
    expect(page.items[0].feeTotalMinor).toBe(236);
    expect(page.items[0].netMinor).toBe(10000 - 236);
    expect(JSON.stringify(page)).not.toMatch(/secret|webhookSecret|encrypted/i);
  });

  it("a client cannot filter by another tenant's business (404) or client id (ignored)", async () => {
    const a = await makeShop({ tag: "a" });
    const b = await makeShop({ tag: "b" });
    await paidOrder(a);
    await paidOrder(b);
    expect(await code(() => listTransactions(a.ctx, { businessId: b.business.id }))).toBe("NOT_FOUND");
    expect(await code(() => transactionTotals(a.ctx, { businessId: b.business.id }))).toBe("NOT_FOUND");
    const sneaky = await listTransactions(a.ctx, { clientId: b.client.id });
    expect(sneaky.total).toBe(1);
    const t = await transactionTotals(a.ctx, { clientId: b.client.id });
    expect(t.count).toBe(1);
    expect(t.grossMinor).toBe(10000);
  });

  it("an out-of-tenant transaction id is NOT_FOUND, not forbidden", async () => {
    const a = await makeShop({ tag: "a" });
    const b = await makeShop({ tag: "b" });
    const pb = await paidOrder(b);
    expect(await code(() => getTransaction(a.ctx, pb.txn.id))).toBe("NOT_FOUND");
    expect(await code(() => getTransaction(a.ctx, "does-not-exist-00000000"))).toBe("NOT_FOUND");
    expect(await code(() => getTransaction(a.ctx, ""))).toBe("VALIDATION");
  });

  it("the admin can filter by client and business and sees everything on getTransaction", async () => {
    const a = await makeShop({ tag: "a" });
    const b = await makeShop({ tag: "b" });
    await paidOrder(a);
    const pb = await paidOrder(b);
    const admin = await makeAdminSession();
    expect((await listTransactions(admin.ctx, { clientId: b.client.id })).total).toBe(1);
    expect((await listTransactions(admin.ctx, { businessId: a.business.id })).total).toBe(1);
    const d = await getTransaction(admin.ctx, pb.txn.id);
    expect(d.id).toBe(pb.txn.id);
  });

  it("business membership limits what a non-owner sees; owner of two businesses sees both", async () => {
    const shop = await makeShop();
    const second = await addBusiness(shop, "Second Shop");
    const product2 = (await createProduct(shop.ctx, { businessId: second.id, name: "Idli", priceMinor: 4000 })) as { id: string; priceMinor: number };
    const qr2 = (await createQr(shop.ctx, { businessId: second.id, type: "BUSINESS", label: "Second" })) as { token: string };
    const p1 = await paidOrder(shop);
    const p2 = await paidOrder({ qrToken: qr2.token, product: product2 });
    expect(p2.txn.amountMinor).toBe(4000);

    const owner = await listTransactions(shop.ctx, {});
    expect(owner.total).toBe(2);
    // The manager only has a membership on the first business.
    const mgr = await listTransactions(shop.managerCtx, {});
    expect(mgr.items.map((t) => t.id)).toEqual([p1.txn.id]);
    expect(await code(() => getTransaction(shop.managerCtx, p2.txn.id))).toBe("NOT_FOUND");
    expect((await transactionTotals(shop.managerCtx, {})).grossMinor).toBe(10000);
    expect((await transactionTotals(shop.ctx, {})).grossMinor).toBe(14000);
  });

  it("clients need payments.view; anonymous is refused", async () => {
    const shop = await makeShop();
    const p = await paidOrder(shop);
    const noView = withPermissions(shop.ctx, ["products.manage"]);
    expect(await code(() => listTransactions(noView, {}))).toBe("FORBIDDEN");
    expect(await code(() => getTransaction(noView, p.txn.id))).toBe("FORBIDDEN");
    expect(await code(() => transactionTotals(noView, {}))).toBe("FORBIDDEN");
    expect(await code(() => listTransactions({ actor: null, ip: "203.0.113.9", userAgent: "x" }, {}))).toBe("UNAUTHENTICATED");
  });

  it("filters by provider, status, method, text and date; rejects invalid filters", async () => {
    const shop = await makeShop({ priceMinor: 10000 });
    const a = await paidOrder(shop);
    const b = await paidOrder(shop);
    await requestRefund(shop.ctx, { transactionId: b.txn.id, amountMinor: 10000, reason: "Full refund", idempotencyKey: idemKey("rf") });
    await db.paymentTransaction.update({ where: { id: a.txn.id }, data: { method: "upi", verifiedAt: new Date("2026-03-05T09:00:00Z") } });

    expect((await listTransactions(shop.ctx, { provider: "DEV_SIMULATOR" })).total).toBe(2);
    expect((await listTransactions(shop.ctx, { provider: "RAZORPAY" })).total).toBe(0);
    expect((await listTransactions(shop.ctx, { status: "REFUNDED" })).items.map((t) => t.id)).toEqual([b.txn.id]);
    expect((await listTransactions(shop.ctx, { status: "SUCCEEDED" })).items.map((t) => t.id)).toEqual([a.txn.id]);
    expect((await listTransactions(shop.ctx, { method: "upi" })).items.map((t) => t.id)).toEqual([a.txn.id]);
    expect((await listTransactions(shop.ctx, { q: a.txn.txnRef.toLowerCase() })).items.map((t) => t.id)).toEqual([a.txn.id]);
    expect((await listTransactions(shop.ctx, { q: "no-such-thing" })).total).toBe(0);
    expect((await listTransactions(shop.ctx, { from: "2026-03-05", to: "2026-03-05" })).items.map((t) => t.id)).toEqual([a.txn.id]);
    expect((await listTransactions(shop.ctx, { from: "2026-03-06" })).items.map((t) => t.id)).toEqual([b.txn.id]);

    expect(await code(() => listTransactions(shop.ctx, { provider: "PAYPAL" }))).toBe("VALIDATION");
    expect(await code(() => listTransactions(shop.ctx, { status: "PENDING" }))).toBe("VALIDATION");
    expect(await code(() => listTransactions(shop.ctx, { from: "05/03/2026" }))).toBe("VALIDATION");
    expect(await code(() => listTransactions(shop.ctx, { pageSize: 100000 }))).toBe("VALIDATION");
  });

  it("paginates", async () => {
    const shop = await makeShop();
    for (let i = 0; i < 3; i++) await paidOrder(shop);
    const p1 = await listTransactions(shop.ctx, { page: 1, pageSize: 2 });
    const p2 = await listTransactions(shop.ctx, { page: 2, pageSize: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p2.items).toHaveLength(1);
    expect(p1.total).toBe(3);
    expect(p1.pageCount).toBe(2);
  });

  it("the list shows flagged duplicates but totals exclude them", async () => {
    const shop = await makeShop();
    const { order, start } = await paidOrder(shop);
    await deliver("DEV_SIMULATOR", simulatorWebhook({ providerOrderId: start.providerOrderId!, providerPaymentId: "sim_pay_dup", amountMinor: order.totalMinor }));
    const page = await listTransactions(shop.ctx, {});
    expect(page.total).toBe(2);
    expect(page.items.filter((t) => t.isDuplicate)).toHaveLength(1);
    const t = await transactionTotals(shop.ctx, {});
    expect(t.count).toBe(1);
    expect(t.grossMinor).toBe(10000);
  });

  it("detail includes items, refunds, attempt history and the refundable amount", async () => {
    const shop = await makeShop();
    const { txn } = await paidOrder(shop);
    await requestRefund(shop.ctx, { transactionId: txn.id, amountMinor: 3000, reason: "Partial return", idempotencyKey: idemKey("rf") });
    const d = await getTransaction(shop.ctx, txn.id);
    expect(d.refundedMinor).toBe(3000);
    expect(d.refundableMinor).toBe(7000);
    expect(d.netMinor).toBe(7000);
    expect(d.refunds).toHaveLength(1);
    expect(d.order.items).toHaveLength(1);
    expect(d.attempt?.history.length).toBeGreaterThan(0);
    expect(JSON.stringify(d)).not.toMatch(/secret|encrypted/i);
  });
});

describe("csv helpers", () => {
  it("prefixes formula triggers with an apostrophe", () => {
    for (const s of ["=1+1", "+cmd|' /C calc'!A0", "-2+3", "@SUM(A1)", "\tcmd", "\rcmd"]) {
      expect(csvCell(s).replace(/^"/, "").startsWith("'")).toBe(true);
    }
    expect(csvCell('=HYPERLINK("http://evil.example","x")')).toBe(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
  });

  it("leaves safe text and real numbers alone, quotes commas, quotes and newlines", () => {
    expect(csvCell("Asha")).toBe("Asha");
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell(12345)).toBe("12345");
    expect(csvCell(10n)).toBe("10");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(true)).toBe("true");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell(new Date("2026-01-02T03:04:05Z"))).toBe("2026-01-02T03:04:05.000Z");
    expect(csvCell("a=b")).toBe("a=b");
  });

  it("toCsv writes a header row, CRLF line ends and a trailing CRLF", () => {
    const out = toCsv([{ a: "x", b: 1 }, { a: "=evil", b: 2 }], [
      { header: "A", get: (r) => r.a },
      { header: "B", get: (r) => r.b },
    ]);
    expect(out).toBe("A,B\r\nx,1\r\n'=evil,2\r\n");
    expect(toCsv([], [{ header: "A", get: () => 1 }])).toBe("A\r\n");
  });
});

describe("CSV export", () => {
  it("exports the filtered rows with money as major units", async () => {
    const shop = await makeShop({ priceMinor: 12345 });
    const { txn } = await paidOrder(shop);
    await db.paymentTransaction.update({ where: { id: txn.id }, data: { feeMinor: 200, feeTaxMinor: 36 } });
    const { csv, filename, truncated } = await exportTransactionsCsv(shop.ctx, {});
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe("Transaction,Verified at,Client,Business,Order,Customer,Provider,Method,Provider payment id,Status,Duplicate,Currency,Gross,Refunded,Fee,Net");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(txn.txnRef);
    expect(lines[1]).toContain("123.45");
    expect(lines[1]).toContain("2.36");
    expect(lines[1]).toContain("121.09");
    expect(filename).toMatch(/^transactions-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(truncated).toBe(false);
  });

  it("neutralises a formula in the customer name", async () => {
    const shop = await makeShop();
    await paidOrder(shop, { customer: { name: "=HYPERLINK(\"http://evil.example\")" } });
    await paidOrder(shop, { customer: { name: "+cmd|calc" } });
    await paidOrder(shop, { customer: { name: "@SUM(1)" } });
    const { csv } = await exportTransactionsCsv(shop.ctx, {});
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/m);
    expect(csv).toContain(`"'=HYPERLINK(`);
    expect(csv).toContain(",'+cmd|calc,");
    expect(csv).toContain(",'@SUM(1),");
    // No cell in any data row may start with a formula trigger.
    for (const line of csv.trimEnd().split("\r\n").slice(1)) {
      expect(line).not.toMatch(/(^|,)[=+@]/);
    }
  });

  it("client export needs reports.export; payments.view alone is not enough", async () => {
    const shop = await makeShop();
    await paidOrder(shop);
    const viewOnly = withPermissions(shop.ctx, ["payments.view"]);
    expect(await code(() => exportTransactionsCsv(viewOnly, {}))).toBe("FORBIDDEN");
    const exportOnly = withPermissions(shop.ctx, ["reports.export"]);
    expect(await code(() => exportTransactionsCsv(exportOnly, {}))).toBe("NO_ERROR");
  });

  it("export is tenant scoped and honours filters", async () => {
    const a = await makeShop({ tag: "a" });
    const b = await makeShop({ tag: "b", priceMinor: 7777 });
    const pa = await paidOrder(a);
    await paidOrder(b);
    const mine = (await exportTransactionsCsv(a.ctx, {})).csv;
    expect(mine).toContain(pa.txn.txnRef);
    expect(mine).not.toContain("77.77");
    expect(mine.trimEnd().split("\r\n")).toHaveLength(2);
    expect(await code(() => exportTransactionsCsv(a.ctx, { businessId: b.business.id }))).toBe("NOT_FOUND");
    const admin = await makeAdminSession();
    expect((await exportTransactionsCsv(admin.ctx, {})).csv.trimEnd().split("\r\n")).toHaveLength(3);
    expect((await exportTransactionsCsv(admin.ctx, { clientId: b.client.id })).csv.trimEnd().split("\r\n")).toHaveLength(2);
  });

  it("an empty result is just the header", async () => {
    const shop = await makeShop();
    const { csv } = await exportTransactionsCsv(shop.ctx, {});
    expect(csv.trimEnd().split("\r\n")).toHaveLength(1);
  });
});

describe("receipts", () => {
  it("returns receipt data for a verified paid order and hides provider ids and secrets", async () => {
    const shop = await makeShop({ priceMinor: 10000 });
    const { order, txn } = await paidOrder(shop);
    const r = await receiptData(order.publicId);
    expect(r.orderCode).toBe(order.orderCode);
    expect(r.txnRef).toBe(txn.txnRef);
    expect(r.status).toBe("PAID");
    expect(r.totalMinor).toBe(order.totalMinor);
    expect(r.refundedMinor).toBe(0);
    expect(r.items).toHaveLength(1);
    expect(r.businessName).toBe(shop.business.name);
    const json = JSON.stringify(r);
    expect(json).not.toContain(txn.providerPaymentId ?? "__none__");
    expect(json).not.toMatch(/secret|encrypted|providerOrderId|asha@example.com/i);
  });

  it("is 404 for an unpaid order, an unknown id, and a cancelled order", async () => {
    const shop = await makeShop();
    const o = await placeOrder(shop);
    expect(await code(() => receiptData(o.publicId))).toBe("NOT_FOUND");
    expect(await code(() => receiptPdf(o.publicId))).toBe("NOT_FOUND");
    expect(await code(() => receiptData("pub_unknown_value_123"))).toBe("NOT_FOUND");
    expect(await code(() => receiptData("x"))).toBe("VALIDATION");
    // A started attempt (redirect without proof) still has no receipt.
    const { order } = await orderWithSimAttempt(shop);
    expect(await code(() => receiptData(order.publicId))).toBe("NOT_FOUND");
  });

  it("reflects a refund in the status and refunded amount", async () => {
    const shop = await makeShop({ priceMinor: 10000 });
    const { order, txn } = await paidOrder(shop);
    await requestRefund(shop.ctx, { transactionId: txn.id, amountMinor: 4000, reason: "Partial return", idempotencyKey: idemKey("rf") });
    const r1 = await receiptData(order.publicId);
    expect(r1.status).toBe("PARTIALLY_REFUNDED");
    expect(r1.refundedMinor).toBe(4000);
    await requestRefund(shop.ctx, { transactionId: txn.id, amountMinor: 6000, reason: "Rest", idempotencyKey: idemKey("rf") });
    const r2 = await receiptData(order.publicId);
    expect(r2.status).toBe("REFUNDED");
    expect(r2.refundedMinor).toBe(10000);
  });

  it("builds a PDF document", async () => {
    const shop = await makeShop();
    const { order } = await paidOrder(shop, { customer: { name: "Zoë नमस्ते" } });
    const { filename, pdf } = await receiptPdf(order.publicId);
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(800);
    expect(filename).toMatch(/\.pdf$/);
    expect(filename).toContain(order.orderCode);
  });

  it("serves JSON and PDF over the public routes, 404 otherwise, without a session", async () => {
    const shop = await makeShop();
    const { order } = await paidOrder(shop);
    const ok = await receiptGet(req("GET", `/api/pay/${order.publicId}/receipt`), seg({ publicId: order.publicId }));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.data.orderCode).toBe(order.orderCode);

    const pdf = await receiptPdfGet(req("GET", `/api/pay/${order.publicId}/receipt/pdf`), seg({ publicId: order.publicId }));
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toContain("attachment");
    const bytes = Buffer.from(await pdf.arrayBuffer());
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    const unpaid = await placeOrder(shop);
    const nf = await receiptGet(req("GET", `/api/pay/${unpaid.publicId}/receipt`), seg({ publicId: unpaid.publicId }));
    expect(nf.status).toBe(404);
    expect((await nf.json()).error.code).toBe("NOT_FOUND");
    const nfPdf = await receiptPdfGet(req("GET", `/api/pay/${unpaid.publicId}/receipt/pdf`), seg({ publicId: unpaid.publicId }));
    expect(nfPdf.status).toBe(404);
  });
});

describe("transaction routes", () => {
  async function two() {
    const a = await makeShop({ tag: "a" });
    const b = await makeShop({ tag: "b", priceMinor: 5000 });
    const pa = await paidOrder(a);
    const pb = await paidOrder(b);
    return { a, b, pa, pb };
  }

  it("client list and totals are scoped; 401 anonymous; 403 without payments.view", async () => {
    const { a, pa } = await two();
    const res = await clientList(req("GET", "/api/client/transactions", { cookie: a.cookie }), P);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.total).toBe(1);
    expect(body.data.items[0].id).toBe(pa.txn.id);

    const tot = await clientList(req("GET", "/api/client/transactions?totals=1", { cookie: a.cookie }), P);
    expect((await tot.json()).data).toMatchObject({ count: 1, grossMinor: 10000, refundedMinor: 0, feeMinor: 0, netMinor: 10000 });

    const anon = await clientList(req("GET", "/api/client/transactions"), P);
    expect(anon.status).toBe(401);

    const limited = await makeShop({ tag: "lim" });
    await db.client.update({ where: { id: limited.client.id }, data: { permissions: ["products.manage"] } });
    const { ctxFromUser } = await import("./helpers-catalog");
    const fresh = await ctxFromUser(limited.user.id);
    const denied = await clientList(req("GET", "/api/client/transactions", { cookie: fresh.cookie }), P);
    expect(denied.status).toBe(403);
  });

  it("client detail: own 200, other tenant 404, bad id 404/422", async () => {
    const { a, pa, pb } = await two();
    const ok = await clientOne(req("GET", `/api/client/transactions/${pa.txn.id}`, { cookie: a.cookie }), seg({ id: pa.txn.id }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).data.id).toBe(pa.txn.id);
    const other = await clientOne(req("GET", `/api/client/transactions/${pb.txn.id}`, { cookie: a.cookie }), seg({ id: pb.txn.id }));
    expect(other.status).toBe(404);
    expect((await other.json()).error.code).toBe("NOT_FOUND");
    const missing = await clientOne(req("GET", "/api/client/transactions/nope-nope-nope", { cookie: a.cookie }), seg({ id: "nope-nope-nope" }));
    expect(missing.status).toBe(404);
  });

  it("client filter on another tenant's business is 404; invalid filter is 422", async () => {
    const { a, b } = await two();
    const res = await clientList(req("GET", `/api/client/transactions?businessId=${b.business.id}`, { cookie: a.cookie }), P);
    expect(res.status).toBe(404);
    const bad = await clientList(req("GET", "/api/client/transactions?status=BOGUS", { cookie: a.cookie }), P);
    expect(bad.status).toBe(422);
  });

  it("client export returns text/csv with a download header; 403 without reports.export; 401 anonymous", async () => {
    const { a, pa } = await two();
    const res = await clientExport(req("GET", "/api/client/transactions/export", { cookie: a.cookie }), P);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="transactions-/);
    expect(res.headers.get("x-export-truncated")).toBe("0");
    const text = await res.text();
    expect(text).toContain(pa.txn.txnRef);
    expect(text.trimEnd().split("\r\n")).toHaveLength(2);

    expect((await clientExport(req("GET", "/api/client/transactions/export"), P)).status).toBe(401);

    const limited = await makeShop({ tag: "lim" });
    await db.client.update({ where: { id: limited.client.id }, data: { permissions: ["payments.view"] } });
    const { ctxFromUser } = await import("./helpers-catalog");
    const fresh = await ctxFromUser(limited.user.id);
    expect((await clientExport(req("GET", "/api/client/transactions/export", { cookie: fresh.cookie }), P)).status).toBe(403);
  });

  it("admin routes see every tenant; a client session is refused", async () => {
    const { a, pa, pb } = await two();
    const admin = await makeAdminSession();
    const list = await adminList(req("GET", "/api/admin/transactions", { cookie: admin.cookie }), P);
    expect(list.status).toBe(200);
    expect((await list.json()).data.total).toBe(2);

    const one = await adminOne(req("GET", `/api/admin/transactions/${pb.txn.id}`, { cookie: admin.cookie }), seg({ id: pb.txn.id }));
    expect(one.status).toBe(200);
    expect((await one.json()).data.id).toBe(pb.txn.id);

    const exp = await adminExport(req("GET", "/api/admin/transactions/export", { cookie: admin.cookie }), P);
    expect(exp.status).toBe(200);
    expect(exp.headers.get("content-type")).toContain("text/csv");
    expect((await exp.text()).trimEnd().split("\r\n")).toHaveLength(3);

    expect((await adminList(req("GET", "/api/admin/transactions", { cookie: a.cookie }), P)).status).toBe(403);
    expect((await adminOne(req("GET", `/api/admin/transactions/${pa.txn.id}`, { cookie: a.cookie }), seg({ id: pa.txn.id }))).status).toBe(403);
    expect((await adminExport(req("GET", "/api/admin/transactions/export", { cookie: a.cookie }), P)).status).toBe(403);
    expect((await adminList(req("GET", "/api/admin/transactions"), P)).status).toBe(401);
  });
});

// Keeps the helper imports used even when a test above is edited.
void PAY_PERMISSIONS;
void customerCtx;
export type _Shop = Shop;
