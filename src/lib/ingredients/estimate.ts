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

import {
  parsePack,
  BASE_BY_DIM,
  DIM_BY_UOM,
  TO_BASE,
  normUom,
  type ParsedPack,
  type BaseUom,
  type Confidence,
  type Dim,
} from "./pack";

// Confidence tier used by the PriceEstimate output. Widens the parser's
// 'high'|'low'|'none' with:
//   'override' - human-attested pack (Phase 1.8). More trusted than 'high'.
//   'derived'  - computed from real invoice spend (Prompt B). Sits
//                between 'low' and 'override' in trust: it's not a
//                guess, but no human has signed it either.
// Parser never emits 'override' or 'derived'.
export type EstimateConfidence = Confidence | "override" | "derived";

// Local helper that mirrors the shape the override path used to carry
// (base_uom + factor + dim per uom), now sourced from the shared tables
// in pack.ts. The three factor tables in the codebase were verified
// byte-identical before this collapse (Prompt B, 2026-10-29).
function uomFactor(uom: string): { base_uom: BaseUom; factor: number; dim: Dim } | null {
  const dim = DIM_BY_UOM[uom];
  const factor = TO_BASE[uom];
  if (!dim || factor == null) return null;
  return { base_uom: BASE_BY_DIM[dim], factor, dim };
}

export type EstimateInputs = {
  // vendor item fields
  pack_text: string | null;
  catch_weight: boolean;
  // supplied latest billed stats (newest invoice_date wins; kept as a
  // fallback when the aggregated actuals below aren't usable).
  latest_unit_price: number | null;
  // catalog match (either side may be null if no match)
  catalog_pack_text: string | null;
  catalog_price: number | null;
  // Blended invoice actuals for this item (Prompt B). Null/zero fields
  // mean "no usable actuals" and every actuals tier is skipped - the
  // engine falls through to today's catalog/billed/pack behavior.
  actuals?: {
    sum_extended: number;
    sum_quantity: number;
    sum_weight: number;
    billed_unit: string | null;
    unit_consistent: boolean;
    n_lines: number;
  } | null;
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
  //   'actuals_base_unit' - Prompt B: invoice is already priced per
  //                   base unit (billed as $/lb, $/each, $/gal, etc.);
  //                   per_base = Σ extended / Σ base_units. No pack math.
  //   'actuals_weight' - Prompt B: catch-weight item with real billed
  //                   weight; per_base = Σ extended / Σ weight_line_value.
  //   'actuals_case' - Prompt B: non-catch; case price = Σ extended /
  //                   Σ quantity (preferred over catalog list / billed
  //                   latest), still divided by pack total_base.
  case_price_source:
    | "catalog"
    | "billed"
    | "catch_weight"
    | "catalog_lb"
    | "override"
    | "actuals_base_unit"
    | "actuals_weight"
    | "actuals_case"
    | null;
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
  // Look up the shared factor table (pack.ts); null means the uom
  // isn't one we can convert, same semantics as the former local
  // OVERRIDE_TO_BASE guard.
  const conv = input.uom ? uomFactor(input.uom) : null;
  const uom = conv ? input.uom : null;
  if (qty == null || size == null || uom == null || conv == null) {
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

  const a = input.actuals ?? null;
  const actualsUsable =
    a != null &&
    a.unit_consistent &&
    a.n_lines >= 1 &&
    a.sum_extended > 0;

  // ---------------------------------------------------------------
  // TIER A - base-unit short-circuit (Prompt B).
  // When the invoice is already priced per base unit (unit=lb, each,
  // gal, etc.) AND the item's lines are unit-consistent, there's no
  // pack math to do: Σ extended / Σ base_units IS the $/base. This
  // fires BEFORE the catch-weight branch - a lb-billed case is a
  // better signal than any catch-weight fallback.
  // ---------------------------------------------------------------
  if (actualsUsable && a!.sum_quantity > 0) {
    const billedUomNorm = normUom(a!.billed_unit);
    const conv = billedUomNorm ? uomFactor(billedUomNorm) : null;
    if (conv && billedUomNorm) {
      const sumBaseUnits = a!.sum_quantity * conv.factor;
      if (sumBaseUnits > 0) {
        const perBase = a!.sum_extended / sumBaseUnits;
        if (Number.isFinite(perBase) && perBase > 0) {
          const baseLabel = conv.base_uom === "FLOZ" ? "fl oz" : conv.base_uom.toLowerCase();
          const billedLabel = billedUomNorm === "FLOZ" ? "fl oz" : billedUomNorm.toLowerCase();
          return {
            parsed,
            estimate: {
              per_base: perBase,
              base_uom: conv.base_uom,
              case_price: null,
              case_price_source: "actuals_base_unit",
              pack_source: packSource,
              confidence: "derived",
              note: `blended $/${baseLabel} from ${a!.n_lines} invoice line${a!.n_lines === 1 ? "" : "s"} billed per ${billedLabel}`,
            },
          };
        }
      }
    }
  }

  // Catch-weight branch. The invoice unit_price IS $/lb when a case
  // ships by actual weight. Precedence here (Prompt B inserts the
  // actuals_weight tier at the top):
  //   1. Σ extended / Σ weight_line_value - the blended $/lb from
  //      actual billed weight ("derived" confidence).
  //   2. Latest billed unit_price interpreted as $/lb.
  //   3. Catalog price interpreted as $/lb (Phase 1.7).
  //   4. Neither: `none`.
  if (input.catch_weight) {
    if (actualsUsable && a!.sum_weight > 0) {
      const perLb = a!.sum_extended / a!.sum_weight;
      if (Number.isFinite(perLb) && perLb > 0) {
        return {
          parsed,
          estimate: {
            per_base: perLb,
            base_uom: "LB",
            case_price: null,
            case_price_source: "actuals_weight",
            pack_source: packSource,
            confidence: "derived",
            note: `catch-weight: blended $/lb from actual billed weight (${a!.n_lines} line${a!.n_lines === 1 ? "" : "s"})`,
          },
        };
      }
    }
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

  // Case price with provenance. Prompt B: Σ extended / Σ quantity
  // beats both catalog list and billed latest - it's what we actually
  // paid, not what the sheet said.
  const actualsCase =
    actualsUsable && a!.sum_quantity > 0
      ? a!.sum_extended / a!.sum_quantity
      : null;
  const catalogPrice =
    input.catalog_price != null && input.catalog_price > 0 ? input.catalog_price : null;
  const billedPrice =
    input.latest_unit_price != null && input.latest_unit_price > 0 ? input.latest_unit_price : null;

  let casePrice: number | null = null;
  let priceSource:
    | "actuals_case"
    | "catalog"
    | "billed"
    | null = null;
  if (actualsCase != null && Number.isFinite(actualsCase) && actualsCase > 0) {
    casePrice = actualsCase;
    priceSource = "actuals_case";
  } else if (catalogPrice != null) {
    casePrice = catalogPrice;
    priceSource = "catalog";
  } else if (billedPrice != null) {
    casePrice = billedPrice;
    priceSource = "billed";
  }

  // Catalog-vs-actuals disagreement flag. When actuals_case wins AND a
  // catalog list price exists AND they differ > 3x in either direction,
  // keep the actuals number (we paid it) but surface the disagreement
  // in the note so review knows.
  let disagreementNote: string | null = null;
  if (
    priceSource === "actuals_case" &&
    catalogPrice != null &&
    casePrice != null &&
    (casePrice / catalogPrice > 3 || catalogPrice / casePrice > 3)
  ) {
    disagreementNote = `actuals $${casePrice.toFixed(2)} vs catalog $${catalogPrice.toFixed(2)}; using actuals`;
  }

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

  // Final confidence: min(parsed, "derived") when actuals_case wins
  // (we trust the real spend as much as the pack lets us, never more).
  // Otherwise defer to the parser.
  const finalConfidence: EstimateConfidence =
    priceSource === "actuals_case"
      ? parsed.confidence === "high"
        ? "derived"
        : parsed.confidence // 'low' or 'none' (none already returned above)
      : parsed.confidence;

  const combinedNote = [parsed.note, disagreementNote].filter(Boolean).join("; ") || null;

  return {
    parsed,
    estimate: {
      per_base: casePrice / parsed.total_base,
      base_uom: parsed.base_uom,
      case_price: casePrice,
      case_price_source: priceSource,
      pack_source: packSource,
      confidence: finalConfidence,
      note: combinedNote,
    },
  };
}
