// N13 §3.3: single source for pulling perBase + perBaseUom (and the
// adjacent confidence + note) out of a pr_vendor_items.price_estimate
// JSON column. Previously inlined in src/app/api/review/item/route.ts;
// lifted so VendorItemsPage's new row-shaping can read the same
// values as the item-panel API with no risk of drift.
//
// The route's response must be byte-identical before and after this
// refactor - every field this helper now owns is a pure read + cast
// of what the route already computed.

export type PerBaseConfidence = "high" | "low" | "override" | "derived";

export type PriceEstimate = {
  per_base?: number | null;
  base_uom?: string | null;
  case_price?: number | null;
  case_price_source?: string | null;
  pack_source?: string | null;
  match_source?: string | null;
  match_score?: number | null;
  confidence?: string | null;
  note?: string | null;
} | null;

export type ReadPerBase = {
  perBase: number | null;
  perBaseUom: string | null;
  perBaseConfidence: PerBaseConfidence | null;
  perBaseNote: string | null;
};

export function readPerBase(pe: PriceEstimate): ReadPerBase {
  if (!pe) return { perBase: null, perBaseUom: null, perBaseConfidence: null, perBaseNote: null };
  const perBase =
    pe.per_base != null && Number.isFinite(Number(pe.per_base)) ? Number(pe.per_base) : null;
  const perBaseConfidence: PerBaseConfidence | null =
    pe.confidence === "high" || pe.confidence === "low" || pe.confidence === "override" || pe.confidence === "derived"
      ? (pe.confidence as PerBaseConfidence)
      : null;
  return {
    perBase,
    perBaseUom: pe.base_uom ?? null,
    perBaseConfidence,
    perBaseNote: pe.note ?? null,
  };
}
