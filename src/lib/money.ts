/** Money helpers. All amounts are integers in minor units (paise). */

export function formatMinor(minor: number, currency = "INR"): string {
  const major = minor / 100;
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency, minimumFractionDigits: 2 }).format(major);
  } catch {
    return `${currency} ${major.toFixed(2)}`;
  }
}

/** ASCII-only variant for PDFs/CSV where the rupee glyph may be unavailable. */
export function formatMinorPlain(minor: number, currency = "INR"): string {
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const whole = Math.trunc(abs / 100).toString().replace(/\B(?=(\d{2})*\d{3}(?!\d))/g, ",");
  const frac = String(abs % 100).padStart(2, "0");
  return `${neg ? "-" : ""}${currency} ${whole}.${frac}`;
}

/** Parse "123", "123.4", "123.45" into minor units without floating point. */
export function parseMajorToMinor(input: string): number | null {
  const s = input.trim().replace(/,/g, "");
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const whole = parseInt(m[1], 10);
  const frac = parseInt((m[2] ?? "").padEnd(2, "0") || "0", 10);
  return whole * 100 + frac;
}

export function minorToMajorString(minor: number): string {
  const abs = Math.abs(minor);
  return `${minor < 0 ? "-" : ""}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Integer percentage in basis points with round-half-up. */
export function bpsOf(amountMinor: number, bps: number): number {
  return Math.floor((amountMinor * bps + 5000) / 10000);
}
