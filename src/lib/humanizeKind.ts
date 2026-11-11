// Humanize pr_events.kind for ledger surfaces. Returns the correct form
// based on count ("twin flagged" vs "twins flagged"); unknown kinds fall
// back to a title-cased, hyphenated form of the enum so no raw enum
// reaches the UI.

const LABELS: Record<string, { single: string; plural: string }> = {
  vendor_item_twin:   { single: "twin flagged",    plural: "twins flagged" },
  vendor_created:     { single: "vendor created",  plural: "vendors created" },
  status_changed:     { single: "status change",   plural: "status changes" },
  intake_completed:   { single: "intake completed", plural: "intakes completed" },
  // N6: each-measure writes. Ingredient and vendor-item each carry
  // their own row so the ledger reads "one each measure set" (ingredient)
  // vs "item each measure set" (vendor item).
  ingredient_each_measure_set:  { single: "one each measure set",  plural: "one each measures set" },
  vendor_item_each_measure_set: { single: "item each measure set", plural: "item each measures set" },
};

export function humanizeKind(kind: string, count: number = 1): string {
  const row = LABELS[kind];
  if (row) return count === 1 ? row.single : row.plural;
  const words = kind.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
