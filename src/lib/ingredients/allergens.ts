// Canonical allergens for the master ingredient dictionary. The nine
// strings here are the whole surface - defined once, imported
// everywhere (UI, route handler, write helper, migration audit).
// Pack size: nine. Any variation is a bug.
//
// Constraints that go with these values, by ruling:
//   - These exact strings are what gets stored. A CHECK constraint on
//     pr_ingredients.allergens rejects anything else, so a typo or a
//     re-pluralisation is a runtime database error, not a cosmetic
//     one.
//   - "Shellfish" covers molluscs AND crustaceans - scallops, clams,
//     mussels, squid all get this tag. Do not split.
//   - Gluten is deliberately NOT in the set. Barley and rye are gluten
//     and are not wheat, so a gluten tag here would make a malt item
//     read wheat-free-therefore-gluten-free. Do not add.
//   - Every value in the stored column is typed by a human. No
//     inference from names, descriptions, barcodes, or vendor data.
//
// Three-state model lives next to this constant because every reader
// needs to agree on it:
//
//   | state           | encoding                             | label              |
//   | --------------- | ------------------------------------ | ------------------ |
//   | unreviewed      | allergens_reviewed_at IS NULL        | "Check allergens"  |
//   | confirmed none  | reviewed_at set, allergens empty     | "No Top 9 allergens" |
//   | confirmed       | reviewed_at set, allergens non-empty | the tags           |
//
// The single most important invariant: an unreviewed ingredient must
// never render as having no allergens. Unreviewed and confirmed-none
// are different facts and must look different at a glance - this is
// the bug the schema fixes, not one we are allowed to ship.

export const ALLERGENS = [
  "Milk",
  "Eggs",
  "Fish",
  "Shellfish",
  "Tree Nuts",
  "Peanuts",
  "Wheat",
  "Soy",
  "Sesame",
] as const;

export type Allergen = (typeof ALLERGENS)[number];

const ALLERGEN_SET: ReadonlySet<string> = new Set<string>(ALLERGENS);

export function isAllergen(x: unknown): x is Allergen {
  return typeof x === "string" && ALLERGEN_SET.has(x);
}

// Narrow an arbitrary input to the canonical nine, preserving the
// canonical order defined above. Writers call this before POSTing so
// a stray value never reaches the API. Non-allergen strings are
// silently dropped (the API also rejects them server-side; this is
// the UI-side guard).
export function normalizeAllergens(input: readonly unknown[]): Allergen[] {
  const picked = new Set<Allergen>();
  for (const v of input) if (isAllergen(v)) picked.add(v);
  return ALLERGENS.filter((a) => picked.has(a));
}

export type AllergenReview = {
  // The nine, in canonical order. May be empty.
  allergens: readonly Allergen[];
  // ISO timestamp when the current state was confirmed; null means
  // the ingredient is unreviewed and must render "Check allergens".
  reviewedAt: string | null;
  // Actor identity (email) attached to the current state. Null when
  // reviewedAt is null; carries the same value as the pr_events row's
  // `actor` column.
  reviewedBy: string | null;
};

export function isUnreviewed(r: Pick<AllergenReview, "reviewedAt">): boolean {
  return r.reviewedAt == null;
}

export function isConfirmedNone(r: AllergenReview): boolean {
  return r.reviewedAt != null && r.allergens.length === 0;
}
