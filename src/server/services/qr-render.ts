import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { formatMinorPlain } from "@/lib/money";
import { qrUrl } from "./qr";

/** Printable PNG: error correction Q, 1024 px, 4-module quiet zone. */
export async function renderQrPng(token: string, opts: { size?: number } = {}): Promise<Buffer> {
  const width = Math.min(2048, Math.max(256, opts.size ?? 1024));
  return QRCode.toBuffer(qrUrl(token), { type: "png", errorCorrectionLevel: "Q", margin: 4, width, color: { dark: "#000000", light: "#ffffff" } });
}

/** pdfkit's built-in fonts cover WINDOWS-1252 only; keep text to printable ASCII. */
export const asciiOnly = (s: string) => s.replace(/[^\x20-\x7E]/g, "?").trim();

export interface QrPdfInput {
  token: string;
  label: string;
  businessName: string;
  currency?: string;
  fixedAmountMinor?: number | null;
}

/** A5 portrait poster: business, label, QR, "Scan to pay". */
export async function renderQrPdf(input: QrPdfInput): Promise<Buffer> {
  const png = await QRCode.toBuffer(qrUrl(input.token), { type: "png", errorCorrectionLevel: "Q", margin: 2, width: 900 });
  const doc = new PDFDocument({ size: "A5", margin: 36, info: { Title: asciiOnly(input.label) || "QR code", Producer: "YouPI" } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const w = doc.page.width;
  const inner = w - 72;
  doc.fillColor("#111827").font("Helvetica-Bold").fontSize(20).text(asciiOnly(input.businessName) || "Business", 36, 48, { width: inner, align: "center" });
  doc.moveDown(0.3).font("Helvetica").fontSize(13).fillColor("#4b5563").text(asciiOnly(input.label), { width: inner, align: "center" });
  if (input.fixedAmountMinor) {
    doc.moveDown(0.3).font("Helvetica-Bold").fontSize(15).fillColor("#111827").text(formatMinorPlain(input.fixedAmountMinor, input.currency ?? "INR"), { width: inner, align: "center" });
  }
  const size = Math.min(inner, 270);
  const y = Math.max(doc.y + 24, 150);
  doc.image(png, (w - size) / 2, y, { width: size, height: size });
  doc.font("Helvetica-Bold").fontSize(22).fillColor("#111827").text("Scan to pay", 36, y + size + 20, { width: inner, align: "center" });
  doc.font("Helvetica").fontSize(9).fillColor("#6b7280").text("Open your camera or any UPI app and point it at the code.", 36, doc.y + 6, { width: inner, align: "center" });
  doc.end();
  return done;
}
