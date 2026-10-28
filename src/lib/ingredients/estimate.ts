// Per-unit price estimate helper. Pure function; takes the item + its
// catalog match + latest billed stats and returns the PriceEstimate
// jsonb to be stamped onto pr_vendor_items.price_estimate.
//
// Rules:
//   - Pack precedence: catalog pack_text > invoice pack_text.
//   - Price precedence: catalog price > latest billed unit_price.
//   - Catch-weight items: ignore the pack formula; use billed $/lb
//     directly (latest unit_price interpreted as $/lb). confidence='low'.
//   - per_base is only emitted when parse confidence is high/low AND a
//     case price exists. Otherwise null (never a guessed number).
//
// Confidence on the estimate = min(parse confidence, price availability).

import { parsePack, type ParsedPack, type BaseUom, type Confidence } from "./pack";

// Confidence tier used by the PriceEstimate output. Widens the parser's
// 'high'|'low'|'none' with an 'override' tier reserved for human-
// attested packs (Phase 1.8 structured override). Treat 'override' as
// trusted - more authoritative than 'high'. Parser never emits
// 'override'.
export type EstimateConfidence = Confidence | "override";

// Dimension lookup for the structured-override path. Mirrors pack.ts
// internals (which aren't exported); kept narrow to the four base
// conversions this helper needs.
const OVERRIDE_TO_BASE: Record<string, { base_uom: BaseUom; factor: number; dim: "weight" | "volume" | "count" }> = {
  // weight -> LB
  LB: { base_uom: "LB", factor: 1, dim: "weight" },
  OZ: { base_uom: "LB", factor: 1 / 16, dim: "weight" },
  G: { base_uom: "LB", factor: 1 / 453.592, dim: "weight" },
  KG: { base_uom: "LB", factor: 2.20462, dim: "weight" },
  // volume -> FLOZ
  FLOZ: { base_uom: "FLOZ", factor: 1, dim: "volume" },
  L: { base_uom: "FLOZ", factor: 33.814, dim: "volume" },
  ML: { base_uom: "FLOZ", factor: 0.033814, dim: "volume" },
  GAL: { base_uom: "FLOZ", factor: 128, dim: "volume" },
  QT: { base_uom: "FLOZ", factor: 32, dim: "volume" },
  PT: { base_uom: "FLOZ", factor: 16, dim: "volume" },
  // count -> EA
  EA: { base_uom: "EA", factor: 1, dim: "count" },
  DZ: { base_uom: "EA", factor: 12, dim: "count" },
  CT: { base_uom: "EA", factor: 1, dim: "count" },
  PC: { base_uom: "EA", factor: 1, dim: "count" },
};

export type EstimateInputs = {
  // vendor item fields
  pack_text: string | null;
  catch_weight: boolean;
  // supplied latest billed stats
  latest_unit_price: number | null;
  // catalog match (either side may be null if no match)
  catalog_pack_text: string | null;
  catalog_price: number | null;
};

export type PriceEstimate = {
  per_base: number | null;
  base_uom: BaseUom | null;
  case_price: number | null;
  // case_price_source values:
  //   'catalog'     - non-catch pack math: catalog_price (case) / total_base
  //   'billed'      - non-catch pack math: latest invoice price / total_base
  //   'catch_weight'- catch-weight item, billed $/lb from invoice (primary)
  //   'catalog_lb'  - catch-weight item, catalog price interpreted as $/lb
  //                   (Phase 1.7 fallback when no billed data exists;
  //                    always 'low' confidence - the shipped weight varies).
  //   'override'    - Phase 1.8 structured override; the human attested
  //                   the pack and (for catch) the $/lb directly.
  case_price_source: "catalog" | "billed" | "catch_weight" | "catalog_lb" | "override" | null;
  pack_source: "catalog" | "invoice" | "override" | null;
  confidence: EstimateConfidence;
  note: string | null;
  // How the catalog row (if any) was looked up:
  //   'sku'          - matched on (vendor_id, item_number_norm) [primary]
  //   'catalog_name' - name fallback on (vendor_id, exact normalized clean_name)
  //                    with an unambiguous single-pack guard (Phase 1.9).
  // Absent on pre-1.9 rows and on rows with no catalog hit at all.
  match_source?: "sku" | "catalog_name";
};

// Also expose the pack parse result so the backfill can write
// pack_qty/pack_size/pack_uom in one pass.
export type EstimateResult = {
  parsed: ParsedPack;
  estimate: PriceEstimate;
};

// Structured-override estimator (Phase 1.8). Input is user-attested
// qty/size/uom (non-catch) or $/lb (catch); no parsing. Returns the
// PriceEstimate at confidence 'override' plus the derived total_base
// so callers can also write pack_qty/pack_size/pack_uom alongside.
//
// Non-catch path:
//   total_base = qty * size * TO_BASE[uom] (per OVERRIDE_TO_BASE)
//   per_base = case_price / total_base when both > 0, else null
//   case_price = catalog_price (case) ?? latest_unit_price, with source
// Catch-weight path:
//   per_base = per_lb directly, base_uom = 'LB'
//   case_price omitted (billed differs per shipment); source 'override'
// On input error (missing required field for the active path) returns
// confidence 'override' with per_base null so the pack still gets saved
// and the row carries the attestation; the row ends up as `override`
// state without a per-unit (same pattern as "no case price on file").
export type StructuredOverrideInput = {
  catch_weight: boolean;
  // non-catch fields
  qty: number | null;
  size: number | null;
  uom: string | null;
  // catch-weight field
  per_lb: number | null;
  // prices on file (used only for non-catch per-base math; catch takes per_lb directly)
  catalog_price: number | null;
  latest_unit_price: number | null;
  // optional annotation
  note?: string | null;
};

export type StructuredOverrideResult = {
  per_base: number | null;
  base_uom: BaseUom | null;
  dim: "weight" | "volume" | "count" | null;
  total_base: number | null;
  qty: number | null;
  size: number | null;
  uom: string | null;
  case_price: number | null;
  case_price_source: "catalog" | "billed" | "override" | null;
  confidence: EstimateConfidence; // always 'override' from this entry point
  note: string | null;
};

export function estimateFromOverride(input: StructuredOverrideInput): StructuredOverrideResult {
  const noteBase = input.note?.trim() || null;

  if (input.catch_weight) {
    const perLb = input.per_lb != null && input.per_lb > 0 ? input.per_lb : null;
    if (perLb == null) {
      return {
        per_base: null,
        base_uom: "LB",
        dim: "weight",
        total_base: null,
        qty: null,
        size: null,
        uom: null,
        case_price: null,
        case_price_source: null,
        confidence: "override",
        note: noteBase ?? "catch-weight override: $/lb missing",
      };
    }
    return {
      per_base: perLb,
      base_uom: "LB",
      dim: "weight",
      total_base: null,
      qty: null,
      size: null,
      uom: null,
      case_price: null,
      case_price_source: "override",
      confidence: "override",
      note: noteBase ?? "catch-weight: $/lb set by human",
    };
  }

  const qty = input.qty != null && input.qty > 0 ? input.qty : null;
  const size = input.size != null && input.size > 0 ? input.size : null;
  const uom = input.uom && OVERRIDE_TO_BASE[input.uom] ? input.uom : null;
  if (qty == null || size == null || uom == null) {
    return {
      per_base: null,
      base_uom: null,
      dim: null,
      total_base: null,
      qty: input.qty,
      size: input.size,
      uom: input.uom,
      case_price: null,
      case_price_source: null,
      confidence: "override",
      note: noteBase ?? "override missing qty/size/uom",
    };
  }

  const conv = OVERRIDE_TO_BASE[uom];
  const total_base = qty * size * conv.factor;

  const catalogPrice =
    input.catalog_price != null && input.catalog_price > 0 ? input.catalog_price : null;
  const billedPrice =
    input.latest_unit_price != null && input.latest_unit_price > 0 ? input.latest_unit_price : null;
  const casePrice = catalogPrice ?? billedPrice ?? null;
  const priceSource: "catalog" | "billed" | null =
    catalogPrice != null ? "catalog" : billedPrice != null ? "billed" : null;

  if (casePrice == null) {
    return {
      per_base: null,
      base_uom: conv.base_uom,
      dim: conv.dim,
      total_base,
      qty,
      size,
      uom,
      case_price: null,
      case_price_source: null,
      confidence: "override",
      note: noteBase ?? "pack set; no case price on file",
    };
  }

  return {
    per_base: casePrice / total_base,
    base_uom: conv.base_uom,
    dim: conv.dim,
    total_base,
    qty,
    size,
    uom,
    case_price: casePrice,
    case_price_source: priceSource,
    confidence: "override",
    note: noteBase,
  };
}

export function estimatePerUnit(input: EstimateInputs): EstimateResult {
  const packSource: "catalog" | "invoice" | null =
    input.catalog_pack_text && input.catalog_pack_text.trim().length > 0
      ? "catalog"
      : input.pack_text && input.pack_text.trim().length > 0
        ? "invoice"
        : null;
  const chosenPack = input.catalog_pack_text ?? input.pack_text;
  const parsed = parsePack(chosenPack);

  // Catch-weight short-circuit: billed by actual weight means the
  // invoice unit_price IS $/lb. We never trust the pack formula here
  // (even if it parsed cleanly, the per-case weight is only an average).
  //
  // Precedence:
  //   1. Billed $/lb from the latest invoice - most accurate; it's
  //      the actual shipped weight.
  //   2. Phase 1.7 fallback: catalog_price interpreted as $/lb when
  //      no billed data exists. Verified in real data that
  //      pr_vendor_catalog.catalog_price for catch-weight items is a
  //      per-pound rate (not a case total). Flagged `low` so Kevin
  //      verifies in review; the shipped weight still varies.
  //   3. Neither: `none` with a note.
  if (input.catch_weight) {
    const perLb = input.latest_unit_price;
    if (perLb != null && perLb > 0) {
      return {
        parsed,
        estimate: {
          per_base: perLb,
          base_uom: "LB",
          case_price: null,
          case_price_source: "catch_weight",
          pack_source: packSource,
          confidence: "low",
          note: "catch-weight: latest billed $/lb used",
        },
      };
    }
    const catalogLb =
      input.catalog_price != null && input.catalog_price > 0 ? input.catalog_price : null;
    if (catalogLb != null) {
      return {
        parsed,
        estimate: {
          per_base: catalogLb,
          base_uom: "LB",
          case_price: null,
          case_price_source: "catalog_lb",
          pack_source: packSource,
          confidence: "low",
          note:
            "catch-weight: catalog $/lb used (nominal; shipped weight varies - verify)",
        },
      };
    }
    return {
      parsed,
      estimate: {
        per_base: null,
        base_uom: null,
        case_price: null,
        case_price_source: null,
        pack_source: packSource,
        confidence: "none",
        note: "catch-weight: no billed $/lb data",
      },
    };
  }

  // Case price with provenance.
  const catalogPrice =
    input.catalog_price != null && input.catalog_price > 0 ? input.catalog_price : null;
  const billedPrice =
    input.latest_unit_price != null && input.latest_unit_price > 0 ? input.latest_unit_price : null;
  const casePrice = catalogPrice ?? billedPrice ?? null;
  const priceSource: "catalog" | "billed" | null =
    catalogPrice != null ? "catalog" : billedPrice != null ? "billed" : null;

  if (parsed.confidence === "none" || parsed.total_base == null || parsed.total_base <= 0) {
    return {
      parsed,
      estimate: {
        per_base: null,
        base_uom: parsed.base_uom,
        case_price: casePrice,
        case_price_source: priceSource,
        pack_source: packSource,
        confidence: "none",
        note: parsed.note ?? "pack unparsed",
      },
    };
  }

  if (casePrice == null) {
    return {
      parsed,
      estimate: {
        per_base: null,
        base_uom: parsed.base_uom,
        case_price: null,
        case_price_source: null,
        pack_source: packSource,
        confidence: "none",
        note: "no case price available",
      },
    };
  }

  return {
    parsed,
    estimate: {
      per_base: casePrice / parsed.total_base,
      base_uom: parsed.base_uom,
      case_price: casePrice,
      case_price_source: priceSource,
      pack_source: packSource,
      confidence: parsed.confidence, // 'high' or 'low'
      note: parsed.note,
    },
  };
}
