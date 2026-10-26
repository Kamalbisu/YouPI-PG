/** Amounts are stored as integer paise (1 rupee = 100 paise). */

/** "100", "100.5" or "100.50" -> paise. Returns null when empty, NaN-like or out of range. */
export function parseRupees(input: unknown): number | null | "invalid" {
  if (input === undefined || input === null) return null;
  const s = String(input).trim().replace(/,/g, "");
  if (s === "") return null;
  if (!/^[0-9]{1,9}(\.[0-9]{1,2})?$/.test(s)) return "invalid";
  const [r, p = ""] = s.split(".");
  const paise = Number(r) * 100 + Number(p.padEnd(2, "0"));
  if (paise <= 0 || paise > 10_000_000_00) return "invalid";
  return paise;
}

export function formatRupees(paise: number): string {
  const rupees = paise / 100;
  return `₹${rupees.toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(rupees) ? 0 : 2, maximumFractionDigits: 2 })}`;
}
