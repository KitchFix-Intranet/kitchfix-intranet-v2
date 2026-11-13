// M1: measures foundation. Pure, no DB imports, importable from server
// routes and client components (same RSC-boundary shape as pack.ts).
// Built on DIM_BY_UOM + TO_BASE from pack.ts; adds a cross-dim graph
// over the three stored bridges (count-weight, count-volume, volume-
// weight) that migration 0019 enforces via pr_ingredient_measures_pair.
//
// Replaces src/lib/ingredients/eachMeasure.ts. The three N6 rules still
// hold: (1) derived at display, never stored, (2) null in null out, and
// (3) "only each-priced items convert" is RELAXED - the new library
// converts in any direction a measure row supports. In M1 the five
// display call sites only ask for the conversion they ask for today
// (each-priced item -> per weight or volume), so no screen lights up
// a new direction. deriveRecipePrice preserves that exact behaviour.

import { DIM_BY_UOM, TO_BASE, WEIGHT_UOMS, VOLUME_UOMS } from "./pack";

// M1 R2 fix 5: narrow vocabulary. The DB's pr_unit_dim() knows only EA
// plus the four weight uoms plus the six volume uoms; anything else
// (DZ / CT / PC / CAN10) maps to a null kind on the measure path. The
// library must refuse those at the application boundary so the DB
// constraint is not relied on to produce a sentence.
const MEASURE_FROM_UNITS: ReadonlySet<string> = new Set<string>(["EA", ...VOLUME_UOMS]);
const MEASURE_TO_UNITS: ReadonlySet<string> = new Set<string>([...WEIGHT_UOMS, ...VOLUME_UOMS]);

// --- Types ---------------------------------------------------------------

export type MeasureSource =
  | "house_test"
  | "book"
  | "vendor_spec"
  | "estimate"
  | "pack";

export const MEASURE_SOURCES: ReadonlySet<MeasureSource> = new Set<MeasureSource>([
  "house_test",
  "book",
  "vendor_spec",
  "estimate",
  "pack",
]);

export type Measure = {
  from_unit: string;
  qty: number;
  to_unit: string;
  source: MeasureSource;
};

export type MeasuresInput = {
  measures: readonly Measure[];
  caseWeightLb?: number | null;
};

// The three dim pairs pr_ingredient_measures_pair (migration 0019)
// accepts. Same-kind conversions (OZ-LB, PT-GAL, etc.) are built in and
// never stored.
const ALLOWED_DIM_PAIRS: ReadonlySet<string> = new Set<string>([
  "count:weight",
  "count:volume",
  "volume:weight",
]);

function dimPairKey(fromDim: string, toDim: string): string {
  return `${fromDim}:${toDim}`;
}

// --- Graph math ----------------------------------------------------------

// `factor(from, to, m)` returns the number K such that
//   1 unit of `from` equals K units of `to`.
// So to convert a value v in `from` to its equivalent in `to`:
//   v_in_to = v * factor(from, to, m)
// And to convert a price $/A to $/B:
//   $/B = ($/A) / factor(A, B, m)
// because 1 A = factor(A,B) B means $p/A corresponds to $p per factor(A,B) B.
//
// Same-dim path uses TO_BASE directly (built in). Cross-dim path BFSes
// over dims using the measures as edges; each measure adds a (forward,
// inverse) edge pair so a weight-to-count query is served by a count-
// to-weight row.
export function factor(
  from: string,
  to: string,
  m: MeasuresInput,
): number | null {
  const fu = String(from || "").toUpperCase();
  const tu = String(to || "").toUpperCase();
  if (!fu || !tu) return null;
  const fd = DIM_BY_UOM[fu];
  const td = DIM_BY_UOM[tu];
  const ft = TO_BASE[fu];
  const tt = TO_BASE[tu];
  if (!fd || !td || ft == null || tt == null) return null;
  if (fd === td) {
    // Same dim: 1 fu = ft fd-base; 1 tu = tt fd-base; so 1 fu = ft/tt tu.
    return ft / tt;
  }
  // Cross-dim: walk the dim graph with measures as edges.
  //
  // Each measure (rf → rt) carries a forward factor:
  //   forward = (q * rtt) / rft  which is  "rt-bases in 1 rf-base"
  // and an inverse 1/forward for walking the other way.
  const edges: Array<[string, string, number]> = [];
  for (const row of m.measures) {
    const rfu = String(row.from_unit || "").toUpperCase();
    const rtu = String(row.to_unit || "").toUpperCase();
    const rf = DIM_BY_UOM[rfu];
    const rt = DIM_BY_UOM[rtu];
    const q = Number(row.qty);
    const rft = TO_BASE[rfu];
    const rtt = TO_BASE[rtu];
    if (!rf || !rt) continue;
    if (!Number.isFinite(q) || q <= 0) continue;
    if (rft == null || rtt == null) continue;
    const forward = (q * rtt) / rft; // rt-bases per 1 rf-base
    edges.push([rf, rt, forward], [rt, rf, 1 / forward]);
  }
  // BFS from the source dim; `seen[d]` stores "d-bases in 1 fd-base".
  const seen: Record<string, number> = { [fd]: 1 };
  const queue: string[] = [fd];
  while (queue.length) {
    const x = queue.shift() as string;
    if (x === td) {
      // 1 fu = ft fd-base = ft * seen[td] td-base = ft * seen[td] / tt tu.
      return (ft * seen[td]) / tt;
    }
    for (const [ef, et, k] of edges) {
      if (ef === x && !(et in seen)) {
        seen[et] = seen[x] * k;
        queue.push(et);
      }
    }
  }
  return null;
}

// --- Library-level price helper ---------------------------------------

// Case price in a target unit. Mirrors the render's priceIn: when the
// item has a case weight, that weight REPLACES the measure for this
// item only (§2.2); otherwise the case's own pack (amount + unit)
// is the start of the conversion through the ingredient's measures.
//
// `casePrice` is the whole-case dollars. Target total is the case's
// size in the target unit; per-target = casePrice / total.
//
// M1 R2 fix 2: caseWeightLb short-circuits the measure graph for this
// item's price, which is why a count case with its own 10 lb weight
// prices at casePrice / 10 regardless of the ingredient's count-to-
// weight row.
export function priceIn(
  per: {
    casePrice: number;
    packAmt: number;
    packUnit: string;
    caseWeightLb: number | null;
  },
  targetUom: string,
  m: MeasuresInput,
): { per: number; total: number; via: string; conv: boolean } | null {
  if (!Number.isFinite(per.casePrice) || per.casePrice <= 0) return null;
  const target = String(targetUom || "").toUpperCase();
  let total: number;
  let via: string;
  let conv = false;
  if (per.caseWeightLb != null && per.caseWeightLb > 0) {
    const k = factor("LB", target, m);
    if (k == null || !Number.isFinite(k) || k <= 0) return null;
    total = per.caseWeightLb * k;
    via = `This case weighs ${roundDisplay(per.caseWeightLb)} lb`;
    conv = DIM_BY_UOM[target] !== "weight";
  } else {
    const pu = String(per.packUnit || "").toUpperCase();
    if (!Number.isFinite(per.packAmt) || per.packAmt <= 0) return null;
    const k = factor(pu, target, m);
    if (k == null || !Number.isFinite(k) || k <= 0) return null;
    total = per.packAmt * k;
    via = `${roundDisplay(per.packAmt)} ${pu.toLowerCase()} in the case`;
    conv = DIM_BY_UOM[pu] !== DIM_BY_UOM[target];
  }
  if (!Number.isFinite(total) || total <= 0) return null;
  return { per: per.casePrice / total, total, via, conv };
}

function roundDisplay(n: number): string {
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : String(r);
}

// --- Reach -----------------------------------------------------------------

// Which units can be reached from any of `startUnits` through the
// measures graph (same-dim + cross-dim). Powers the "Recipes can use"
// chip set when M2 wires it; included in M1 for the library test battery.
export function reachableUnits(
  startUnits: readonly string[],
  m: MeasuresInput,
): Set<string> {
  const result = new Set<string>();
  const vocab = Object.keys(DIM_BY_UOM);
  for (const start of startUnits) {
    for (const u of vocab) {
      if (factor(start, u, m) != null) result.add(u);
    }
  }
  return result;
}

// --- Validation ------------------------------------------------------------

// Explain why this measures-graph `from -> to` is already answered by the
// existing rows. Used to produce the render's "Already covered..." sentence
// when a user tries to add a third row whose bridge is already a two-step
// composition of two existing rows.
function pathSentence(
  fromUnit: string,
  toUnit: string,
  existing: readonly Measure[],
): string | null {
  const k = factor(fromUnit, toUnit, { measures: existing });
  if (k == null) return null;
  const rounded = Math.round(k * 100) / 100;
  return `Already covered. Your other measures make 1 ${fromUnit} = ${rounded} ${toUnit}. Edit one of those so there is only one answer.`;
}

// Validate a candidate measure against the current list. Returns null
// when the row is addable, or a one-sentence reason it must not be.
// The sentence is routed to the user; the DB constraints are the
// backstop.
export function rejectReason(
  candidate: Measure,
  existing: readonly Measure[],
): string | null {
  const from = String(candidate.from_unit || "").toUpperCase();
  const to = String(candidate.to_unit || "").toUpperCase();
  if (!from) return "from_unit required";
  if (!to) return "to_unit required";
  if (candidate.from_unit !== from) {
    return `from_unit must be uppercase (got ${JSON.stringify(candidate.from_unit)})`;
  }
  if (candidate.to_unit !== to) {
    return `to_unit must be uppercase (got ${JSON.stringify(candidate.to_unit)})`;
  }
  const q = Number(candidate.qty);
  if (!Number.isFinite(q)) return "qty must be a finite number";
  // DB: pr_ingredient_measures_qty_range (qty > 0 and qty <= 100000).
  if (q <= 0 || q > 100000) {
    return "qty must be greater than 0 and at most 100000";
  }
  // DB: pr_ingredient_measures_source_vocab (in the five values).
  if (!MEASURE_SOURCES.has(candidate.source)) {
    return "source must be one of house_test, book, vendor_spec, estimate, pack";
  }
  const fd = DIM_BY_UOM[from];
  const td = DIM_BY_UOM[to];
  if (!fd) return `from_unit ${from} is not a known unit`;
  if (!td) return `to_unit ${to} is not a known unit`;
  // M1 R2 fix 5: narrow from/to vocabulary to what pr_unit_dim knows.
  // DZ / CT / PC are count tokens the DB does not map on the measure
  // path; CAN10 is pack-editor-only. Named count units (loaf, slice)
  // are out of scope per prompt §2.1.
  if (!MEASURE_FROM_UNITS.has(from)) {
    const allowed = ["EA", ...VOLUME_UOMS].join(", ");
    return `from_unit ${from} is not stored in a measure; from_unit must be one of ${allowed}`;
  }
  if (!MEASURE_TO_UNITS.has(to)) {
    const allowed = [...WEIGHT_UOMS, ...VOLUME_UOMS].join(", ");
    return `to_unit ${to} is not stored in a measure; to_unit must be one of ${allowed}`;
  }
  if (fd === td) {
    return `${from} and ${to} are both ${fd} units; same-kind conversions are built in and are never stored as a measure`;
  }
  // DB: pr_ingredient_measures_pair (count-weight, count-volume, volume-weight only).
  const pairKey = dimPairKey(fd, td);
  if (!ALLOWED_DIM_PAIRS.has(pairKey)) {
    return "Only three bridges are stored: count to weight, count to volume, volume to weight. Write this as one of those.";
  }
  // DB: pr_ingredient_measures_one_per_pair UNIQUE (ingredient_id, from_dim, to_dim).
  // One row per DIM pair (not unit pair): a count-to-weight row blocks another
  // count-to-weight row regardless of which weight unit each uses.
  const sameKind = existing.find((r) => {
    const rfd = DIM_BY_UOM[r.from_unit.toUpperCase()];
    const rtd = DIM_BY_UOM[r.to_unit.toUpperCase()];
    return rfd === fd && rtd === td;
  });
  if (sameKind) {
    const sentence = pathSentence(from, to, existing);
    if (sentence) return sentence;
    return `A ${fd}-to-${td} measure already exists for this ingredient. Edit that row.`;
  }
  // Graph already composes to this bridge: two existing rows yield the
  // answer via a path, so the render's sentence names the computed
  // value and tells the user which row to edit. Checked BEFORE the
  // max-2 trigger so the actionable sentence wins when both fire.
  const covered = pathSentence(from, to, existing);
  if (covered) return covered;
  // DB: pr_ingredient_measures_no_loop_trg (max 2 rows per ingredient).
  if (existing.length >= 2) {
    return "An ingredient can hold at most two measures; a third would give two different answers for the same conversion.";
  }
  return null;
}

// --- Display-site backward compatibility ---------------------------------

// Amendment 5: in M1 the five display sites ask exactly the conversion
// they ask today - each-priced item ($ per each) + one measure (item or
// ingredient) -> $ per the measure's dim-base. Preserved byte-identical
// so every screen renders the same number for the same input, now via
// the measures graph underneath.

export type EachMeasureInput = { qty: number; uom: string } | null;

export function deriveRecipePrice(input: {
  perBase: number | null;
  perBaseUom: string | null;
  itemMeasure: EachMeasureInput;
  ingredientMeasure: EachMeasureInput;
}): {
  per: number;
  uom: "LB" | "FLOZ" | "GAL";
  qty: number;
  measureUom: string;
  from: "item" | "ingredient";
} | null {
  if (input.perBaseUom !== "EA") return null;
  const p = Number(input.perBase);
  if (!Number.isFinite(p) || p <= 0) return null;

  const pick = validOne(input.itemMeasure)
    ? { m: input.itemMeasure as { qty: number; uom: string }, from: "item" as const }
    : validOne(input.ingredientMeasure)
      ? {
          m: input.ingredientMeasure as { qty: number; uom: string },
          from: "ingredient" as const,
        }
      : null;
  if (!pick) return null;

  const uomU = pick.m.uom.toUpperCase();
  const dim = DIM_BY_UOM[uomU];
  if (dim !== "weight" && dim !== "volume") return null;

  // One-row measures input mirroring the stored each-measure.
  const measures: Measure[] = [
    { from_unit: "EA", qty: pick.m.qty, to_unit: uomU, source: "book" },
  ];
  const dimBase = dim === "weight" ? "LB" : "FLOZ";
  const k = factor("EA", dimBase, { measures });
  if (k == null || !Number.isFinite(k) || k <= 0) return null;

  // $/EA = $p; 1 EA = k dim-base-units; so $/dim-base = $p / k.
  const perDimBase = p / k;

  if (dim === "weight") {
    return {
      per: perDimBase,
      uom: "LB",
      qty: pick.m.qty,
      measureUom: uomU,
      from: pick.from,
    };
  }
  // Volume: display per GAL when the typed uom is GAL/QT/L; else per FLOZ.
  if (uomU === "GAL" || uomU === "QT" || uomU === "L") {
    const kGal = factor("FLOZ", "GAL", { measures: [] });
    if (kGal == null || !Number.isFinite(kGal) || kGal <= 0) {
      return {
        per: perDimBase,
        uom: "FLOZ",
        qty: pick.m.qty,
        measureUom: uomU,
        from: pick.from,
      };
    }
    // $/FLOZ * (FLOZ per GAL). factor(FLOZ, GAL) = 1/128 (1 FLOZ = 1/128 GAL),
    // so $/GAL = ($/FLOZ) / (1/128) = perDimBase / kGal.
    return {
      per: perDimBase / kGal,
      uom: "GAL",
      qty: pick.m.qty,
      measureUom: uomU,
      from: pick.from,
    };
  }
  return {
    per: perDimBase,
    uom: "FLOZ",
    qty: pick.m.qty,
    measureUom: uomU,
    from: pick.from,
  };
}

function validOne(m: EachMeasureInput): boolean {
  if (!m) return false;
  if (!Number.isFinite(m.qty) || m.qty <= 0) return false;
  const u = m.uom.toUpperCase();
  const dim = DIM_BY_UOM[u];
  if (dim !== "weight" && dim !== "volume") return false;
  const f = TO_BASE[u];
  return f != null && Number.isFinite(f) && f > 0;
}
