// G1 - grade model. Grade is a property of the VENDOR ITEM, not of
// the ingredient. A master ingredient rolls up three prices from its
// live items: blended (all), standard (grade is null or non-premium),
// premium (grade = 'premium').
//
// Canonical rules (from STOCKPOT_GRADE_MODEL_SPEC.md):
//
//   - null is standard. The only sanctioned non-null value is
//     'premium'. Roughly 97% of items are and will remain null.
//   - Any non-premium value is treated as standard by the UI. The
//     column is text (not an enum) so a third tier is a data change
//     and not a migration; UI holds the line at two values.
//   - A grade subset with no items yields null, not zero. Null must
//     render as "-", never as $0.00 (the Retail-bug lesson).

export type Grade = "standard" | "premium";

// Narrows a raw column value to the canonical two-value space the UI
// recognises. Called by every reader so a stray third value never
// surfaces as its own tier.
export function gradeOf(raw: string | null | undefined): Grade {
  return raw === "premium" ? "premium" : "standard";
}

// Price-selector key space. "blended" is not a Grade (it's a
// composite view); kept separate to keep the Grade type tight.
export type PriceLens = "blended" | Grade;

export const PRICE_LENS_LABEL: Record<PriceLens, string> = {
  blended: "Blended",
  standard: "Standard",
  premium: "Premium",
};

// Human label for the item panel's grade control + anywhere the
// stored column value is surfaced.
export function gradeLabel(raw: string | null | undefined): string {
  return gradeOf(raw) === "premium" ? "Premium" : "Standard";
}
