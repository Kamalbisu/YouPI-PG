import PDFDocument from "pdfkit";
import { z } from "zod";
import { db } from "@/lib/db";
import { notFound } from "@/lib/errors";
import { formatMinorPlain } from "@/lib/money";
import { parse } from "@/lib/validation";
import { METHOD_LABELS, type PaymentMethod } from "./checkout";

/** pdfkit's built-in fonts cover WINDOWS-1252 only; keep text to printable ASCII. */
const ascii = (s: string | null | undefined) => (s ?? "").replace(/[^\x20-\x7E]/g, "?");

export interface ReceiptData {
  orderCode: string;
  txnRef: string;
  businessName: string;
  businessCode: string;
  status: "PAID" | "PARTIALLY_REFUNDED" | "REFUNDED";
  currency: string;
  items: { name: string; quantity: number; unitPriceMinor: number; taxMinor: number; lineTotalMinor: number }[];
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  refundedMinor: number;
  method: string | null;
  methodLabel: string;
  paidAt: string;
  customerName: string | null;
}

/**
 * Receipt data for a public order id. Only orders with a backend-verified payment qualify (a PaymentTransaction
 * row exists and the order is PAID or refunded); anything else is a 404 so an unpaid link never yields a receipt.
 * No provider ids, secrets or internal ids are included.
 */
export async function receiptData(publicId: string): Promise<ReceiptData> {
  const id = parse(z.string().trim().min(8).max(100), publicId);
  const o = await db.order.findUnique({
    where: { publicId: id },
    include: {
      items: { orderBy: { id: "asc" } },
      business: { select: { name: true, businessCode: true } },
      transactions: { where: { isDuplicate: false }, orderBy: { verifiedAt: "asc" }, take: 1 },
    },
  });
  if (!o) throw notFound("Receipt");
  const txn = o.transactions[0];
  if (!txn || !(o.status === "PAID" || o.status === "PARTIALLY_REFUNDED" || o.status === "REFUNDED")) throw notFound("Receipt");
  return {
    orderCode: o.orderCode,
    txnRef: txn.txnRef,
    businessName: o.business.name,
    businessCode: o.business.businessCode,
    status: o.status,
    currency: o.currency,
    items: o.items.map((i) => ({ name: i.name, quantity: i.quantity, unitPriceMinor: i.unitPriceMinor, taxMinor: i.taxMinor, lineTotalMinor: i.lineTotalMinor })),
    subtotalMinor: o.subtotalMinor,
    discountMinor: o.discountMinor,
    taxMinor: o.taxMinor,
    totalMinor: o.totalMinor,
    refundedMinor: txn.refundedMinor,
    method: txn.method,
    methodLabel: txn.method && txn.method in METHOD_LABELS ? METHOD_LABELS[txn.method as PaymentMethod] : txn.method ? ascii(txn.method) : "Online payment",
    paidAt: (o.paidAt ?? txn.verifiedAt).toISOString(),
    customerName: o.customerName,
  };
}

/** One-page A5 PDF receipt (ASCII only, amounts as "INR 1,234.00"). */
export async function receiptPdf(publicId: string): Promise<{ filename: string; pdf: Buffer }> {
  const r = await receiptData(publicId);
  const doc = new PDFDocument({ size: "A5", margin: 36, info: { Title: `Receipt ${r.orderCode}`, Producer: "YouPI" } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const money = (n: number) => formatMinorPlain(n, r.currency);
  const row = (label: string, value: string, bold = false) => {
    const y = doc.y;
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(10).text(label, 36, y, { width: 200 });
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(10).text(value, 236, y, { width: doc.page.width - 36 - 236, align: "right" });
    doc.moveDown(0.3);
  };

  doc.font("Helvetica-Bold").fontSize(16).text(ascii(r.businessName));
  doc.font("Helvetica").fontSize(10).fillColor("#555555").text("Payment receipt").fillColor("#000000");
  doc.moveDown(0.8);
  row("Order", r.orderCode);
  row("Transaction", r.txnRef);
  row("Paid on", r.paidAt.replace("T", " ").slice(0, 16) + " UTC");
  row("Payment method", ascii(r.methodLabel));
  if (r.customerName) row("Customer", ascii(r.customerName));
  doc.moveDown(0.5);
  doc.moveTo(36, doc.y).lineTo(doc.page.width - 36, doc.y).strokeColor("#cccccc").stroke();
  doc.moveDown(0.5);
  for (const i of r.items) row(`${ascii(i.name)} x ${i.quantity}`, money(i.lineTotalMinor));
  doc.moveDown(0.3);
  row("Subtotal", money(r.subtotalMinor));
  if (r.discountMinor > 0) row("Discount", `-${money(r.discountMinor)}`);
  row("Tax", money(r.taxMinor));
  row("Total paid", money(r.totalMinor), true);
  if (r.refundedMinor > 0) row("Refunded", money(r.refundedMinor));
  doc.moveDown(1);
  doc.font("Helvetica").fontSize(8).fillColor("#777777").text("This receipt was generated after the payment was verified. Keep it for your records.");
  doc.end();
  return { filename: `receipt-${r.orderCode}.pdf`, pdf: await done };
}
