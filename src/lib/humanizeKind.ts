// Humanize pr_events.kind for ledger surfaces. Returns the correct form
// based on count ("twin flagged" vs "twins flagged"); unknown kinds fall
// back to a title-cased, hyphenated form of the enum so no raw enum
// reaches the UI.

const LABELS: Record<string, { single: string; plural: string }> = {
  vendor_item_twin:   { single: "twin flagged",    plural: "twins flagged" },
  vendor_created:     { single: "vendor created",  plural: "vendors created" },
  status_changed:     { single: "status change",   plural: "status changes" },
  intake_completed:   { single: "intake completed", plural: "intakes completed" },
};

export function humanizeKind(kind: string, count: number = 1): string {
  const row = LABELS[kind];
  if (row) return count === 1 ? row.single : row.plural;
  const words = kind.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
