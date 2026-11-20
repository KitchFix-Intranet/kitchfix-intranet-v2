// T5b round 2 item 4: the ONE naming rule a vendor item carries
// on screen. The review card shows this exact text in bold; Recent
// decisions on the first page and on "Show more" pages show the
// same thing. Previously the ledger was reading `description_key`
// (the match key) which differs from `name` on about four items
// in ten.
//
// Precedence:
//   1. pr_vendor_catalog.clean_name  - the catalog's human name
//      for this vendor + item_number_norm. Used by the card as
//      displayName when a catalog row joins. Null for items with
//      no catalog join.
//   2. pr_vendor_items.name          - the OCR'd label on the
//      invoice. Always present on a real row.
//   3. "Item"                        - the floor. Shown when the
//      row has been renamed away or removed.
//
// description_key stays as a MATCHING key (used by the matcher and
// by alias resolution). Never displayed.
//
// The function is pure; the catalog join is done by the caller
// (one batched read of pr_vendor_catalog keyed by (vendor_id,
// item_number_norm), same shape ReviewQueue.loadReview already
// uses). Loaders that do not have a catalog in hand pass null for
// cleanName and fall through to name.

export type ItemNameInput = {
  cleanName?: string | null;
  name?: string | null;
};

export function displayNameFor(it: ItemNameInput): string {
  const clean = typeof it.cleanName === "string" ? it.cleanName.trim() : "";
  if (clean.length > 0) return clean;
  const nm = typeof it.name === "string" ? it.name.trim() : "";
  if (nm.length > 0) return nm;
  return "Item";
}
