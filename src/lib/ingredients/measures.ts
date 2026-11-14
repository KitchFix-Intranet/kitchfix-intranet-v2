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

// --- The one price function (M2 §2.1) ------------------------------------

// What the case STATES wins; measures only fill what it does not state.
// Kevin's ruling, M2 R1 amendment 2:
//
//   count  is stated when pack_uom is count (EA/CT/PC/DZ) via
//          pack_qty * pack_size (DZ: *12);
//          OR when pack_qty > 1 and pack_size is in a weight or volume
//          unit (count = pack_qty).
//   weight is stated when pack_uom is a weight unit
//          (pack_qty * pack_size, converted to LB).
//   volume is stated when pack_uom is a volume unit
//          (pack_qty * pack_size, converted to FLOZ).
//   case_weight_lb, when set, REPLACES the weight for that item only;
//          it does not change the item's stated count or volume.
//
// If the target's kind is stated, price = case price / total in target.
// No measure involved.
// Otherwise convert FROM a stated kind THROUGH the ingredient's
// measures, trying weight -> volume -> count.
// If pack fields are missing, fall back to per_base / factor(base_uom,
// target) and ignore case weight.

type StatedKind = "weight" | "volume" | "count";
type Totals = Partial<Record<StatedKind, { qty: number; uom: string }>>;

function statedTotals(
  packQty: number | null,
  packSize: number | null,
  packUom: string | null,
  caseWeightLb: number | null,
  m: MeasuresInput,
): Totals {
  const out: Totals = {};
  const pu = (packUom ?? "").toUpperCase();
  const pq = Number(packQty ?? NaN);
  const ps = Number(packSize ?? NaN);
  const havePack = pu && Number.isFinite(pq) && Number.isFinite(ps) && pq > 0 && ps > 0;
  if (havePack) {
    const dim = DIM_BY_UOM[pu];
    if (dim === "count") {
      // Count packs (EA / CT / PC / DZ) always state their count.
      const mult = pu === "DZ" ? 12 : 1;
      out.count = { qty: pq * ps * mult, uom: "EA" };
    } else if (dim === "weight") {
      const totalLb = pq * ps * (TO_BASE[pu] ?? 0);
      if (totalLb > 0) out.weight = { qty: totalLb, uom: "LB" };
      // M2 R2 rule 1: a SIZED pack (pq > 1 in a weight unit) states
      // its count ONLY when the ingredient's measures do not already
      // bridge EA to this uom. When the measure exists, the pack
      // states only its weight and "each" is reached through the
      // measure.
      if (pq > 1 && factor("EA", pu, m) == null) {
        out.count = { qty: pq, uom: "EA" };
      }
    } else if (dim === "volume") {
      const totalFloz = pq * ps * (TO_BASE[pu] ?? 0);
      if (totalFloz > 0) out.volume = { qty: totalFloz, uom: "FLOZ" };
      // Same rule for sized volume packs.
      if (pq > 1 && factor("EA", pu, m) == null) {
        out.count = { qty: pq, uom: "EA" };
      }
    }
  }
  if (caseWeightLb != null && Number.isFinite(caseWeightLb) && caseWeightLb > 0) {
    out.weight = { qty: caseWeightLb, uom: "LB" };
  }
  return out;
}

// Case price derived from per-base + pack. casePrice = perBase * case
// contents in baseUom. The common case has packUom same-dim as baseUom
// (N6 convention: baseUom is the dim-base of packUom). When they
// differ, same-dim factor() returns null and we return null -
// cross-dim items use the fallback path in priceInUnit.
function casePriceFromPerBase(
  perBase: number,
  baseUom: string,
  packQty: number | null,
  packSize: number | null,
  packUom: string | null,
): number | null {
  const pu = (packUom ?? "").toUpperCase();
  const bu = (baseUom ?? "").toUpperCase();
  const pq = Number(packQty ?? NaN);
  const ps = Number(packSize ?? NaN);
  if (!pu || !bu || !Number.isFinite(pq) || !Number.isFinite(ps) || pq <= 0 || ps <= 0) return null;
  if (DIM_BY_UOM[pu] !== DIM_BY_UOM[bu]) return null;
  // T1 fix 1: TO_BASE.DZ is already 12, so `ratio` converts a DZ pack
  // to its EA total. The former `mult = pu === "DZ" ? 12 : 1` applied
  // the dozen factor a second time and pushed every dozen pack's case
  // price 12x too high. statedTotals() still carries its own "x 12"
  // because its pq * ps is already in EA; this function's pq * ps is
  // in the pack's uom and must only be converted once via `ratio`.
  const ratio = TO_BASE[pu] / TO_BASE[bu];
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  const caseInBase = pq * ps * ratio;
  if (!(caseInBase > 0)) return null;
  return perBase * caseInBase;
}

// M2 R3 fix 7: expose casePrice, total and route as data. Callers
// format the sentence; no price arithmetic outside this library.
export type PriceInUnitResult = {
  per: number;              // $ per targetUom
  casePrice: number | null; // whole-case dollars (null on fallback path)
  total: number;            // case's total in targetUom
  totalUom: string;         // the uom `total` is measured in (upper-case)
  route:
    | { kind: "stated"; from: StatedKind; fromQty: number; fromUom: string; viaCaseWeight: boolean }
    | { kind: "measure"; from: StatedKind; fromQty: number; fromUom: string }
    | { kind: "fallback"; baseUom: string };
};

export function priceInUnit(
  item: {
    perBase: number;
    baseUom: string;
    packQty: number | null;
    packSize: number | null;
    packUom: string | null;
    caseWeightLb: number | null;
  },
  targetUom: string,
  m: MeasuresInput,
): PriceInUnitResult | null {
  if (!Number.isFinite(item.perBase) || item.perBase <= 0) return null;
  const target = String(targetUom || "").toUpperCase();
  const targetDim = DIM_BY_UOM[target];
  if (!targetDim) return null;

  const casePrice = casePriceFromPerBase(
    item.perBase,
    item.baseUom,
    item.packQty,
    item.packSize,
    item.packUom,
  );

  // Fallback path: no pack fields (or cross-dim pack vs. base). Ignore
  // case weight per the ruling.
  if (casePrice == null) {
    const k = factor(item.baseUom, target, m);
    if (k == null || !Number.isFinite(k) || k <= 0) return null;
    return {
      per: item.perBase / k,
      casePrice: null,
      total: 1 / k,
      totalUom: target,
      route: { kind: "fallback", baseUom: item.baseUom.toUpperCase() },
    };
  }

  const totals = statedTotals(item.packQty, item.packSize, item.packUom, item.caseWeightLb, m);

  // 1. Target kind stated → no measure involved.
  const t = totals[targetDim as StatedKind];
  if (t) {
    const totalInTarget = t.qty / TO_BASE[target];
    if (!(totalInTarget > 0)) return null;
    return {
      per: casePrice / totalInTarget,
      casePrice,
      total: totalInTarget,
      totalUom: target,
      route: {
        kind: "stated",
        from: targetDim as StatedKind,
        fromQty: t.qty,
        fromUom: t.uom,
        viaCaseWeight:
          item.caseWeightLb != null && item.caseWeightLb > 0 && targetDim === "weight",
      },
    };
  }

  // 2. Convert from a stated kind through the measures, in order
  //    weight -> volume -> count.
  for (const kind of ["weight", "volume", "count"] as const) {
    const s = totals[kind];
    if (!s) continue;
    const k = factor(s.uom, target, m);
    if (k == null || !Number.isFinite(k) || k <= 0) continue;
    const totalInTarget = s.qty * k;
    if (!(totalInTarget > 0)) continue;
    return {
      per: casePrice / totalInTarget,
      casePrice,
      total: totalInTarget,
      totalUom: target,
      route: {
        kind: "measure",
        from: kind,
        fromQty: s.qty,
        fromUom: s.uom,
      },
    };
  }

  return null;
}

// M2 R2 rule 2: for an ingredient costed by count (each / dozen),
// take its sized packs (pq > 1 with pack_size in weight or volume)
// that STILL state their count under rule 1 - i.e. where the measures
// have not already bridged EA to the pack's uom. Partition those by
// kind (weight with weight, volume with volume; never across kinds).
// If the largest piece size exceeds 1.1 x the smallest in a kind,
// flag every candidate of that kind as "sizes_differ". Priced,
// shown, not in any lens, spend counted as unpriced. Flagged BEFORE
// the outlier rule runs, so an "each" that means two things never
// reaches the blend math at all.
//
// Copy for M2 §4B (not built in 4A): attention head "These cases
// come in different sizes", body "{Ingredient} is costed per each,
// but its cases hold {8 fl oz} and {14 fl oz} pieces. Say what one
// each is, or cost this ingredient per {lb | gal}.", buttons "Add a
// measure" and "Change Costed per". Item status label "Sizes differ".
export type SizedPackItem = {
  id: string;
  packQty: number | null;
  packSize: number | null;
  packUom: string | null;
};

const SIZES_DIFFER_RATIO = 1.1;

export function sizesDifferFlags(
  items: readonly SizedPackItem[],
  measures: readonly Measure[],
  ingredientBaseUnit: string | null | undefined,
): Set<string> {
  const flagged = new Set<string>();
  if (!ingredientBaseUnit) return flagged;
  const bu = ingredientBaseUnit.toLowerCase();
  // The rule only fires for count-costed ingredients.
  if (bu !== "each" && bu !== "dozen") return flagged;
  const m: MeasuresInput = { measures };
  const byDim: Record<"weight" | "volume", Array<{ id: string; sizeInBase: number }>> = {
    weight: [],
    volume: [],
  };
  for (const it of items) {
    const pq = Number(it.packQty ?? NaN);
    const ps = Number(it.packSize ?? NaN);
    const pu = (it.packUom ?? "").toUpperCase();
    if (!pu || !(pq > 1) || !(ps > 0)) continue;
    const dim = DIM_BY_UOM[pu];
    if (dim !== "weight" && dim !== "volume") continue;
    // Only sized packs that STILL state their count are candidates.
    // When the measure bridges EA to this uom, rule 1 has already
    // removed the pack's count; it blends through the measure, so
    // size disagreement does not apply.
    if (factor("EA", pu, m) != null) continue;
    const toBase = TO_BASE[pu] ?? 0;
    if (!(toBase > 0)) continue;
    byDim[dim].push({ id: it.id, sizeInBase: ps * toBase });
  }
  for (const dim of ["weight", "volume"] as const) {
    const list = byDim[dim];
    if (list.length < 2) continue;
    const sizes = list.map((x) => x.sizeInBase);
    const min = Math.min(...sizes);
    const max = Math.max(...sizes);
    if (!(min > 0)) continue;
    if (max > min * SIZES_DIFFER_RATIO) {
      for (const x of list) flagged.add(x.id);
    }
  }
  return flagged;
}

function viaSentence(kind: StatedKind, qty: number, viaCaseWeight: boolean): string {
  const q = Math.round(qty * 1000) / 1000;
  if (kind === "weight") {
    return viaCaseWeight
      ? `This case weighs ${q} lb`
      : `${q} lb in the case`;
  }
  if (kind === "volume") return `${q} fl oz in the case`;
  return `${q} each in the case`;
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
