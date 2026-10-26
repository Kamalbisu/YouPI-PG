import { formatMinor } from "@/lib/money";

export type Portal = "admin" | "client";

/** "12.5" -> 1250 basis points, integer math only. Null when the text is not a percentage with at most two decimals. */
export function parsePercentToBps(input: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 100 + parseInt((m[2] ?? "").padEnd(2, "0") || "0", 10);
}

export function bpsToPercentString(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = bps % 100;
  if (frac === 0) return String(whole);
  return `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}`;
}

export interface DiscountLike {
  discountType: string;
  discountValue: number;
}

export function describeDiscount(p: DiscountLike): string {
  if (p.discountType === "PERCENT") return `${bpsToPercentString(p.discountValue)}% off`;
  if (p.discountType === "FIXED") return `${formatMinor(p.discountValue)} off`;
  return "None";
}

export function describeOfferValue(o: { type: string; value: number }): string {
  return o.type === "PERCENT" ? `${bpsToPercentString(o.value)}% off` : `${formatMinor(o.value)} off`;
}

export interface BusinessOption {
  id: string;
  name: string;
}
