// Plain module (no "use client"): the SortKey type, the SORT_LABELS record,
// and the parseSort helper. The server VendorItemsPage reads the URL and
// calls parseSort(); the client SortSelect renders the <select> that drives
// it. Both import from here. See docs/GOTCHAS.md #13 - a Server Component
// may RENDER a component exported from a "use client" file, but must never
// IMPORT and CALL a plain function/const from one.

export type SortKey = "spend" | "lines" | "last_seen";

export const SORT_LABELS: Record<SortKey, string> = {
  spend: "Annual spend, highest first",
  lines: "Annual lines, highest first",
  last_seen: "Last purchase, newest first",
};

export function parseSort(v: string | undefined): SortKey {
  if (v === "lines" || v === "last_seen") return v;
  return "spend";
}
