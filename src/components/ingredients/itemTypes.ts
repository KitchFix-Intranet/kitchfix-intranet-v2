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
  packState: string;
  packSource: "override" | "catalog" | "invoice" | null;
  packManualOverride: boolean;
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
};

export type ReviewCardIngredient = {
  id: string;
  name: string;
  parent: string | null;
  category: string | null;
  resale: boolean;
};
