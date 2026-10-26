/**
 * CSV output that is safe to open in spreadsheet software.
 * Cells that start with a formula trigger (= + - @ tab CR) are prefixed with an apostrophe so
 * Excel / Sheets treat them as text. Real numbers are written as-is (negative numbers stay numeric).
 */
export interface CsvColumn<T> {
  header: string;
  get: (row: T) => unknown;
}

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else if (typeof v === "number" || typeof v === "bigint") return String(v);
  else if (typeof v === "boolean") s = v ? "true" : "false";
  else s = String(v);
  if (FORMULA_START.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const lines = [columns.map((c) => csvCell(c.header)).join(",")];
  for (const r of rows) lines.push(columns.map((c) => csvCell(c.get(r))).join(","));
  return lines.join("\r\n") + "\r\n";
}
