// Pure. The outbound PDF's file name.
//
// Prompt §6: letters, digits, dash and underscore only. Everything
// else collapses to an underscore; runs are collapsed; both ends
// are trimmed of underscores. Correction 8: `TEST_` prefix in
// test mode.
//
// Shape: [TEST_]<vendor>_<YYYYMMDD>_<number>.pdf
// "." is deliberately not in the allowed set: a vendor name
// like "Acme, Inc." must not keep its trailing dot.

export function cleanPart(s: string | null | undefined): string {
  if (!s) return "";
  // Replace anything that is not A-Z a-z 0-9 - _ with an
  // underscore, then collapse runs, then trim.
  return String(s)
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function dateCompact(isoDate: string | null | undefined): string {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}/.test(isoDate)) return "";
  return `${isoDate.slice(0, 4)}${isoDate.slice(5, 7)}${isoDate.slice(8, 10)}`;
}

export function outboundFileName(
  vendor: string | null | undefined,
  invoiceDate: string | null | undefined,
  invoiceNumber: string | null | undefined,
  mode: "test" | "live",
): string {
  const v = cleanPart(vendor) || "vendor";
  const d = dateCompact(invoiceDate) || "nodate";
  const n = cleanPart(invoiceNumber) || "nonumber";
  const prefix = mode === "test" ? "TEST_" : "";
  return `${prefix}${v}_${d}_${n}.pdf`;
}
