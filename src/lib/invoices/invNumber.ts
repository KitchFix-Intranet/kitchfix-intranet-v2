// invoice_number_normalized - the key the DB uses for the copy check.
// Strip a leading "#" and leading zeros (minimum one digit kept) and
// lowercase. Everything else is preserved. The database stores this
// in `invoice_submissions.invoice_number_normalized`; we compute the
// same shape for drafts here so the two can be compared.
//
// Rules (correction 9 of the train 2 fix-prompt):
//   "#123"  -> "123"
//   "00123" -> "123"
//   "#0"    -> "0"
//   ""      -> ""
//   "  123 " -> "123"   (trimmed first)
//   "A-00123" -> "a-00123" (no leading # or zeros, just lower-cased)

export function normalizeInvoiceNumber(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = String(raw).trim();
  if (!s) return "";
  if (s.startsWith("#")) s = s.slice(1);
  // Strip leading zeros but keep at least one digit when the stripped
  // string starts with digits.
  s = s.replace(/^0+(?=\d)/, "");
  return s.toLowerCase();
}

// Convenience: equals-after-normalize.
export function sameInvoiceNumber(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeInvoiceNumber(a);
  const nb = normalizeInvoiceNumber(b);
  if (!na || !nb) return false;
  return na === nb;
}
