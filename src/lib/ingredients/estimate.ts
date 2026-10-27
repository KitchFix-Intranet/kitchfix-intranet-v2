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
  case_price_source: "catalog" | "billed" | "catch_weight" | "catalog_lb" | null;
  pack_source: "catalog" | "invoice" | null;
  confidence: Confidence;
  note: string | null;
};

// Also expose the pack parse result so the backfill can write
// pack_qty/pack_size/pack_uom in one pass.
export type EstimateResult = {
  parsed: ParsedPack;
  estimate: PriceEstimate;
};

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
