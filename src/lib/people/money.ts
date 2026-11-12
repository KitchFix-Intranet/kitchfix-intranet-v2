// Shared money formatter for the Inbox. The payload stores numbers
// as JS numbers (sometimes strings). Returns "" for anything that
// cannot parse, so a row with no amount renders blank.
export function fmtMoney(v: unknown): string {
  if (v == null || v === "") return "";
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
