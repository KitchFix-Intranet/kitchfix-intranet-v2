// Shared item types. ReviewGroupItem and ReviewCardIngredient used to
// live in ReviewCard.tsx; both the Review queue and (as of Prompt A1)
// the Ingredients pane open the same DetailPanel against them, so the
// types moved to a neutral module. ReviewCard.tsx keeps a re-export
// so legacy imports stay untouched.
//
// Verbatim from the former ReviewCard.tsx declarations - any field or
// semantics change here must be matched in /api/review/item (the
// Ingredients-pane feeder) and in ReviewQueue (the Review-queue
// feeder). The panel reads these fields and they must mean the same
// thing from either door.

export type ReviewGroupItem = {
  id: string;
  // vendorOcrName = the raw invoice/OCR description (verbatim identifier).
  // displayName = catalog clean_name when matched, else the OCR name.
  // Casing rule: never Title-case OCR text; show it de-emphasized when
  // the catalog clean_name is doing the top-line display.
  name: string; // kept as alias for displayName for back-compat with any legacy readers
  vendorOcrName: string;
  displayName: string;
  displayNameSource: "catalog" | "invoice";
  vendor: string;
  itemNumber: string | null;
  pack: string | null;
  packNormalized: string | null;
  // N10 §3: raw pr_vendor_items.pack_uom, fed to inferBaseUnit() in
  // the New-ingredient panel's "Costed per" preview. Already selected
  // at ReviewQueue:145; one row-object field add, no SELECT change.
  packUom: string | null;
  packState: string;
  // P1 correction 2c: 'catalog_sibling' names a pack that came from
  // a proven same-vendor expansion (invoice pack_text matches >=2
  // sibling items whose catalog rows unanimously agree on a slashed
  // form). The item itself has no catalog row. Distinguishable in
  // the panel's ItemFacts label and in the audit ledger.
  packSource: "override" | "catalog" | "invoice" | "catalog_sibling" | null;
  packManualOverride: boolean;
  // Set by hand via /api/review/set-price-override. Independent of
  // packManualOverride: a row can have both at once (A2.2). Keyed off
  // isPriceManualOverride(pack_override) so the same column drives
  // both flags without re-reading the db.
  priceManualOverride: boolean;
  billedUnit: string | null;
  usd12m: number;
  lines12m: number;
  // accounts carries the full array of account codes (e.g. STL-FL, TXR-AZ)
  // so the DetailPanel can render them as pills instead of a count.
  accounts: string[];
  accountsCount: number;
  lastSeen: string | null;
  confidence: string | null;
  reason: string;
  catchWeight: boolean;
  unitPrice: number | null;
  unitPriceUnit: string | null;
  catalogPrice: number | null;
  gtin: string | null;
  // Backfilled per-base price (step 5 Phase 1). perBase + perBaseUom
  // only populated when the parser was high/low confident AND a case
  // price was available. perBaseConfidence='high' renders a quiet check
  // chip; 'low' renders an amber "est." chip; 'override' renders a
  // sturdier green "override" chip (human-attested, Phase 1.8); null
  // falls back to the catalog-or-billed case price display.
  perBase: number | null;
  perBaseUom: string | null;
  perBaseConfidence: "high" | "low" | "override" | "derived" | null;
  perBaseNote: string | null;
  // S4: the case price the engine recorded alongside the stored
  // per_base. May be null when the item was priced by a non-case tier
  // (actuals_base_unit, catch_weight, override). Surfaced so the pack
  // chain's dropdown can offer the engine's actual case figure as a
  // selectable option rather than hiding it as a third source.
  storedCasePrice: number | null;
  caseSource:
    | "catalog"
    | "billed"
    | "catch_weight"
    | "catalog_lb"
    | "override"
    | "actuals_base_unit"
    | "actuals_weight"
    | "actuals_case"
    | null;
  // Flag marker (orthogonal to disposition; the item stays in the
  // queue, this just surfaces on the row + the Overview flagged
  // panel). Phase 1 of the Oct 29 Britt review hand-off.
  flagged: boolean;
  flagNote: string | null;
  flaggedBy: string | null;
  flaggedAt: string | null;
  // G1 (grade model): tier on the item. Null is standard; 'premium'
  // is the only sanctioned non-null value today.
  grade: string | null;
  // P1 §5 (pack provenance): how the catalog row backing this item's
  // pack was matched. 'sku' is exact key; 'catalog_name' is the
  // trigram-fuzzy name fallback introduced in P1. matchScore (0-1)
  // is the trigram similarity, carried for the panel's tooltip. Null
  // when no catalog hit of any kind - pack came from invoice OR was
  // set by hand. The panel reads packSource + matchSource together
  // to label the row in plain words.
  matchSource: "sku" | "catalog_name" | null;
  matchScore: number | null;
  // Q2 §4: free-text pack-note written by the P1/P2 backfill on
  // sibling-filled rows ('inferred from N similar items at this
  // vendor; verify') or derived-pack rows ('pack derived: ...'). Null
  // everywhere else. The panel surfaces this verbatim next to the
  // pack-source label so the reviewer can tell weak corroboration
  // from strong at a glance.
  packNote: string | null;
  // N6: per-item each measure override. Null for most rows; set when
  // this vendor's each is a different size than the ingredient's
  // (a 6-count case holds bigger heads than a 12). deriveRecipePrice
  // reads this first and falls back to the ingredient's measure.
  // Supersedes N5's eachWeightLb; qty + uom replace the pounds-only
  // field, which the DB column each_weight_lb has been emptied of.
  eachMeasure: { qty: number; uom: string } | null;
  // N13 R3: five fields so the item-panel surfaces (strip, attention,
  // head pills) carry what VendorItemDrawer displayed. Present on
  // every /api/review/item response; optional at the type level so
  // the review-queue builder in ReviewQueue.tsx (which this lane is
  // not allowed to touch) compiles unchanged. Consumers default to
  // "no attention line / no pill" when undefined.
  needsReviewLines?: number;
  firstSeen?: string | null;
  status?: string;
  // Tri-state: null = legacy / unknown; the "Not food" pill in the
  // item panel renders only on strict `false`.
  isFood?: boolean | null;
  foodReason?: string | null;
};

// Does this pack_override payload actually represent a human-set
// PACK, or just a protection stamp around a price-only override?
//
// The backfill (src/app/api/admin/pack-backfill/route.ts) gates on
// `pack_override IS NOT NULL` at four points - batch read, mid-loop
// twice, UPDATE WHERE - and that is correct: a human touched this
// row, leave it alone. But the UI must NOT then show "Set by hand"
// on a pack nobody touched; the discriminator `price_only: true`
// identifies the price-override family and this helper is the one
// place that reads it. Every site that used
// `pack_override !== null` to drive packSource="override" or the
// packManualOverride flag calls this instead.
export function isPackManualOverride(packOverride: unknown): boolean {
  if (packOverride == null || typeof packOverride !== "object") return false;
  if ((packOverride as { price_only?: unknown }).price_only === true) return false;
  return true;
}

// Does this pack_override payload carry a hand-set PRICE?
//
// Two shapes qualify:
//   price_only: true           -- row has only a price override
//   price: { per_base, ... }   -- row has BOTH a pack override and
//                                 a price override; the price is
//                                 nested so the pack stays whole.
//
// A row can carry both overrides at once (A2.2) - they are
// independent facts and the panel must show both labels.
export function isPriceManualOverride(packOverride: unknown): boolean {
  if (packOverride == null || typeof packOverride !== "object") return false;
  const po = packOverride as { price_only?: unknown; price?: unknown };
  return po.price_only === true || (po.price != null && typeof po.price === "object");
}

export type ReviewCardIngredient = {
  id: string;
  name: string;
  parent: string | null;
  category: string | null;
  resale: boolean;
  // The master's unit of account (R1 vocabulary: lb | each | gal |
  // dozen). The pack-override chain in A2 reads this to say whether an
  // edit will actually make the item join the blend.
  base_unit: string;
  // B1 (allergens): the three-state model lives on the master. The
  // reviewed timestamp IS the state - null means unreviewed and must
  // render "Check allergens" everywhere; a set timestamp with an
  // empty array is "No Top 9 allergens"; a set timestamp with a
  // non-empty array is the tags. See src/lib/ingredients/allergens.ts
  // for the canonical nine and the three-state rules.
  allergens: string[];
  allergens_reviewed_by: string | null;
  allergens_reviewed_at: string | null;
  // N6: the usual measure of one each on the master. Weight OR volume
  // qty + uom + source (one of house_test | book | vendor_spec |
  // estimate). All null when unknown; deriveRecipePrice returns null
  // in that case. Snake case to match the rest of this type's fields
  // (direct passthrough from pr_ingredients row shape). Supersedes
  // N5's avg_weight_lb + avg_weight_source.
  each_measure_qty: number | null;
  each_measure_uom: string | null;
  each_measure_source: string | null;
};
