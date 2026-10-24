// Minimal CSV escaping. Wraps a cell in quotes if it contains any special
// character; doubles embedded quotes. Keeps bytes well-formed per RFC 4180.

export function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = typeof v === "string" ? v : Array.isArray(v) ? v.join(";") : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(",") + "\r\n";
}
