import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { similarity } from "@/lib/ingredients/trigram";
import { COUNTABLE_OBSERVATIONS_VIEW, applyCountableFilter } from "@/lib/ingredients/countability";

export const dynamic = "force-dynamic";
// Same ceiling as pack-backfill: this route can be slow when a batch
// hits a long-tail of corroborating queries. 300 matches the shape of
// what the batch takes (/api/match, /api/intake, /api/admin/pack-backfill).
export const maxDuration = 300;

// L1 §2: Route B - rescan-apply.
//
// Reads staged rescan rows from pr_rescan_lines, pairs each to its
// stored ai_line_items counterpart, gates and writes field by field,
// handles the pr_vendor_items merge when an item_number write re-keys
// a row onto a colliding dedup_key, and records every outcome.
//
// Behaviours that exist because an obvious implementation is wrong:
//
//   - The live-submission picker prefers a non-`corrected` row. 34 of
//     754 manifest rows pointed at a `corrected` submission; reading
//     the wrong one once cost us a day (§2.2).
//   - Matching is an assignment, not a greedy walk. Chat-Claude's
//     greedy join mis-paired similar lines on one invoice three
//     separate times (two lines both $24.23; SAUSAGE PORK CRMBL
//     against SAUSAGE PORK LINK). Neither price nor description alone
//     is sufficient (§2.2).
//   - Catalog existence is a filter, never a tie-break. 4662721 and
//     4562721 are both real sliced-russet potatoes; the WRONG one is
//     in pr_vendor_catalog and the RIGHT one is only in
//     pr_vendor_items. Prefer the item already in pr_vendor_items on
//     a tie (§2.3).
//   - A header/line gap equal to a printed tax figure is a
//     reconciliation, not a defect. Four invoices measured, all four
//     gaps were sales tax ($4.39, $9.71, $40.03 + one exact match).
//     Never import tax as a line (§2.4).
//   - Writing item_number to a pr_vendor_items row re-keys it via the
//     stored dedup_key generated column; the UPDATE fails on the
//     unique constraint if another row already holds that SKU for
//     the vendor. Check for the collision before writing (§2.5).
//   - Nothing is deleted. The pr_ grants in 0002 carry no DELETE;
//     merges re-point the three child FKs
//     (pr_price_observations.vendor_item_id,
//     pr_golden_links.vendor_item_id,
//     pr_vendor_item_aliases.vendor_item_id) and mark the absorbed
//     row duplicate_of_id + status='duplicate' + link_status='rejected'
//     so it leaves the queue. Reversible (§2.5).
//
// dryRun defaults to TRUE. A caller must opt in to writing. In dryRun
// nothing lands - no pr_vendor_items write, no ai_line_items write,
// no pr_events write, AND no apply_status update on the staging row.
// The guard sits at the single write site in applyToStagedRow and
// every call site funnels through it.

const BATCH = 25; // base invoices per call

// §2.2 match floors. A pair that clears neither is unmatched.
const MATCH_PRICE_TOLERANCE = 0.005; // exact extended_price match
const MATCH_TRIGRAM_FLOOR = 0.55;
// Pair score weights. Exact price is dominant; description trigram
// is a tiebreaker. Both normalised to [0, 1] so they add cleanly.
const SCORE_PRICE_WEIGHT = 1.0;
const SCORE_DESC_WEIGHT = 0.5;

// §2.3 gate thresholds.
const GATE_DESC_PREFIX_LEN = 30;
const GATE_DESC_TRIGRAM_FLOOR = 0.75;
const GATE_PRICE_WITHIN_PCT = 0.15;

// §2.4 corroboration tolerance. A measured line sum within 2 cents
// of the header total is "matches to the cent" in practice.
const CORROBORATION_CENT_TOLERANCE = 0.02;
// Four invoices measured, three sales-tax gaps: $4.39 / $9.71 /
// $40.03. A gap in that shape is only accepted when CC's own notes
// field names it as tax on the invoice's last record.
const RECONCILIATION_TAX_RE = /\btax\b/i;

type StagedLine = {
  id: string;
  invoice_number: string;
  base_invoice_number: string;
  is_correction: boolean;
  visual_order: number;
  page: number | null;
  vendor: string | null;
  description_seen: string | null;
  item_number: string | null;
  pack_count: number | null;
  pack_size_text: string | null;
  pack_raw: string | null;
  pack_confidence: string | null;
  uom: string | null;
  qty_ordered: number | null;
  qty_shipped: number | null;
  unit_price_seen: number | null;
  extended_price_seen: number | null;
  catch_weight: boolean | null;
  notes: string | null;
  apply_status: string;
};

type AiLine = {
  id: string;
  vendor_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  line_num: number | null;
  description: string | null;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  extended_price: number | null;
  item_number: string | null;
  pack_size: string | null;
  uom_raw: string | null;
  parsed_pack_qty: number | null;
  catch_weight_marker: boolean | null;
};

type VendorItem = {
  id: string;
  vendor_id: string;
  item_number: string | null;
  item_number_norm: string | null;
  description_key: string;
  name: string;
  status: string;
  link_status: string;
  ingredient_id: string | null;
  pack_override: unknown;
  flagged: boolean | null;
  flag_note: string | null;
  flagged_by: string | null;
  grade: string | null;
};

type CatalogHit = {
  vendor_id: string;
  item_number_norm: string;
  clean_name: string | null;
  pack_text: string | null;
  catalog_price: number | null;
};

type FieldName =
  | "item_number"
  | "pack_count"
  | "pack_size_text"
  | "uom"
  | "qty_shipped"
  | "unit_price_seen"
  | "extended_price_seen";

type FieldOutcome = "filled" | "corrected" | "skipped" | "rejected" | "conflict";

type LineOutcome = {
  stagedId: string;
  status: "filled" | "corrected" | "skipped" | "rejected" | "conflict" | "annotation" | "unmatched";
  reason: string | null;
  matchedLineId: string | null;
  matchedVendorItemId: string | null;
  fieldOutcomes: Record<string, FieldOutcome>;
  deltaExtendedPrice: number; // signed delta to invoice spend
};

type MergeConflict = {
  vendorItemIdA: string;
  vendorItemIdB: string;
  ingredientA: string | null;
  ingredientB: string | null;
  usd: number;
};

type TopChange = {
  invoiceNumber: string;
  vendor: string | null;
  field: FieldName;
  before: unknown;
  after: unknown;
  deltaAbs: number;
};

// M1 R1: MergePlan hoisted out of the per-line loop so both the live
// executor and the dry-run rehearsal reach the SAME resolver. Carries
// both participating rows directly, set at build time from `vendorItem`
// and the collision-check result. The L1 shape referenced rows only by
// id and relied on a batch-level vendorItemById map that never included
// the collision candidate - which is why 0 of 149 merges executed in
// the first live run. Rows-on-plan removes the map dependency.
type MergePlan = {
  aId: string;
  bId: string;
  aRow: VendorItem;
  bRow: VendorItem;
  survivor: string;
  absorbed: string;
  survivorRow: VendorItem;
  absorbedRow: VendorItem;
  precedence: "confirmed>proposed" | "equal-confirmed" | "proposed>none" | "equal-none";
  differsOnIngredient: boolean;
  ingredientA: string | null;
  ingredientB: string | null;
};

// M1 R1 rehearsal path. Both the live executor and the dry-run
// rehearsal call this. If a future refactor moves back to an id+map
// lookup and forgets to populate the map, both the rehearsal and the
// live run fail together - "worthless if it reports zero on unfixed
// code" per spec. Today's plans always have both rows set at build
// time so this returns ok=true for every plan.
function resolveMergeParticipants(
  plan: MergePlan
):
  | { ok: true; survivor: VendorItem; absorbed: VendorItem }
  | { ok: false; reason: string } {
  const survivor = plan.survivorRow;
  const absorbed = plan.absorbedRow;
  if (!survivor) {
    return {
      ok: false,
      reason: `survivor row missing on plan (survivorId=${plan.survivor}, aId=${plan.aId}, bId=${plan.bId})`,
    };
  }
  if (!absorbed) {
    return {
      ok: false,
      reason: `absorbed row missing on plan (absorbedId=${plan.absorbed}, aId=${plan.aId}, bId=${plan.bId})`,
    };
  }
  return { ok: true, survivor, absorbed };
}

type StructuralMismatch = {
  invoice: string;
  stagedLines: number;
  storedLines: number;
  printedTotal: number | null;
  stagedSum: number;
  storedSum: number;
};

// M1 R3.2 thresholds. A difference is structural when both the absolute
// gap AND the ratio exceed the floors. 37 vs 16 (gap 21, ratio 2.31)
// and 31 vs 23 (gap 8, ratio 1.35) are both classified; 100 vs 94
// (gap 6, ratio 1.06) and 50 vs 45 (gap 5, ratio 1.11) are not.
const STRUCTURAL_MIN_GAP = 5;
const STRUCTURAL_MIN_RATIO = 1.25;

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

function normaliseText(v: string | null): string {
  if (!v) return "";
  return v.trim().toUpperCase().replace(/\s+/g, " ");
}

function normaliseSku(v: string | null): string | null {
  if (!v) return null;
  const n = v.trim().toUpperCase();
  return n || null;
}

// L1 §2.1: a correction overlays its base row field by field, for
// every field the correction sets non-null. The identity columns
// (invoice_number, base_invoice_number, is_correction, visual_order,
// page, vendor) stay on the base; the correction supplies the fields
// it wanted to change. visual_order 99 with every data field null is
// an annotation and never a line.
const DATA_FIELDS: Array<keyof StagedLine> = [
  "description_seen",
  "item_number",
  "pack_count",
  "pack_size_text",
  "pack_raw",
  "pack_confidence",
  "uom",
  "qty_ordered",
  "qty_shipped",
  "unit_price_seen",
  "extended_price_seen",
  "catch_weight",
  "notes",
];

// L3 §3.2: annotation emptiness test is scoped to the eight fields
// that would actually land in ai_line_items. pack_confidence and
// catch_weight are metadata CC sets on every record (e.g. "high" +
// false on the two R2 reconciliation annotations); including them
// made every real annotation look like a data line, so
// lines.annotation reported 0 and matched+unmatched over-counted.
// description_seen, pack_raw and notes do not have a correction
// path to ai_line_items either (description is read for matching
// but never overwritten) so they are also out of this test.
const ANNOTATION_TEST_FIELDS: Array<keyof StagedLine> = [
  "item_number",
  "pack_count",
  "pack_size_text",
  "uom",
  "qty_ordered",
  "qty_shipped",
  "unit_price_seen",
  "extended_price_seen",
];

function isAnnotationShape(r: StagedLine): boolean {
  if (r.visual_order !== 99) return false;
  for (const f of ANNOTATION_TEST_FIELDS) {
    if (r[f] != null) return false;
  }
  return true;
}

function overlayCorrection(base: StagedLine, correction: StagedLine): StagedLine {
  const out: StagedLine = { ...base };
  for (const f of DATA_FIELDS) {
    const cv = correction[f];
    if (cv != null) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (out as any)[f] = cv;
    }
  }
  // Preserve base identity but remember we applied a correction.
  return out;
}

// L1 §2.2 match scorer. A pair clears the floor when extended_price
// matches exactly (within MATCH_PRICE_TOLERANCE) OR description
// trigram >= MATCH_TRIGRAM_FLOOR. Neither alone is sufficient (two
// lines both $24.23; SAUSAGE PORK CRMBL vs SAUSAGE PORK LINK), so
// the score sums both signals and the assignment maximises total
// score over the invoice.
function scorePair(staged: StagedLine, stored: AiLine): { score: number; passesFloor: boolean } {
  const stagedPrice = staged.extended_price_seen;
  const storedPrice = stored.extended_price;
  const priceMatch =
    stagedPrice != null &&
    storedPrice != null &&
    Math.abs(stagedPrice - storedPrice) <= MATCH_PRICE_TOLERANCE;
  const descScore = similarity(
    staged.description_seen ?? "",
    stored.description ?? ""
  );
  const descPasses = descScore >= MATCH_TRIGRAM_FLOOR;
  const passesFloor = priceMatch || descPasses;
  const score =
    (priceMatch ? SCORE_PRICE_WEIGHT : 0) + SCORE_DESC_WEIGHT * descScore;
  return { score, passesFloor };
}

// L1 §2.2: assignment, not greedy. Implemented as
// greedy-then-swap-until-stable because this is an assignment problem
// on small matrices (per-invoice, usually < 50 lines each side). The
// greedy pass picks the current best remaining pair; the swap pass
// examines every unordered pair of matched assignments (i, i') and
// swaps their partners when the swap raises the total pair-score.
// Fixed point is reached in O(n^2) rounds typically, and the
// algorithm is deterministic. Returns pairings where staged[i] <->
// stored[pairing[i]], or pairing[i] = -1 for unmatched.
function assignByScore(
  scores: number[][],
  passesFloor: boolean[][]
): number[] {
  const nStaged = scores.length;
  const nStored = nStaged === 0 ? 0 : scores[0].length;
  const pairing = new Array<number>(nStaged).fill(-1);
  if (nStaged === 0 || nStored === 0) return pairing;

  // --- Greedy pass. Collect all above-floor cells, sort by score
  // desc, take in order while both sides are still free. ---
  const cells: Array<{ i: number; j: number; s: number }> = [];
  for (let i = 0; i < nStaged; i++) {
    for (let j = 0; j < nStored; j++) {
      if (!passesFloor[i][j]) continue;
      cells.push({ i, j, s: scores[i][j] });
    }
  }
  // Deterministic sort: score desc, then (i, j) asc on ties so the
  // same input always produces the same assignment. JS Array.sort is
  // stable in Node 12+, but ties here would still pick arbitrary (i,j)
  // without an explicit tiebreak.
  cells.sort((a, b) => b.s - a.s || a.i - b.i || a.j - b.j);
  const stagedUsed = new Array<boolean>(nStaged).fill(false);
  const storedUsed = new Array<boolean>(nStored).fill(false);
  for (const c of cells) {
    if (stagedUsed[c.i] || storedUsed[c.j]) continue;
    pairing[c.i] = c.j;
    stagedUsed[c.i] = true;
    storedUsed[c.j] = true;
  }

  // --- Swap-until-stable. For every pair of matched staged rows
  // (a, b), see if swapping their partners raises the sum of their
  // two scores. If it does, apply the swap; mark that we improved
  // and keep going until a full pass finds no improvement. ---
  const matchedList = () => {
    const r: number[] = [];
    for (let i = 0; i < nStaged; i++) if (pairing[i] !== -1) r.push(i);
    return r;
  };
  let improved = true;
  let guard = 0;
  while (improved && guard < 1000) {
    improved = false;
    guard += 1;
    const matched = matchedList();
    for (let x = 0; x < matched.length; x++) {
      for (let y = x + 1; y < matched.length; y++) {
        const a = matched[x];
        const b = matched[y];
        const ja = pairing[a];
        const jb = pairing[b];
        if (ja === -1 || jb === -1) continue;
        const current = scores[a][ja] + scores[b][jb];
        // Both swapped cells must still pass the floor to be legal.
        if (!passesFloor[a][jb] || !passesFloor[b][ja]) continue;
        const swapped = scores[a][jb] + scores[b][ja];
        if (swapped > current + 1e-9) {
          pairing[a] = jb;
          pairing[b] = ja;
          improved = true;
        }
      }
    }
  }
  return pairing;
}

// L1 §2.3 gate. Returns pass + reason (reason filled on reject so the
// outcome row can name which stage failed).
type GateResult =
  | { pass: true; source: "vendor_item" | "catalog"; vendorItemId?: string }
  | { pass: false; reason: "existence" | "description" | "price" };

function descriptionAgrees(
  stagedDesc: string | null,
  candidateName: string | null
): boolean {
  if (!stagedDesc || !candidateName) return false;
  const a = normaliseText(stagedDesc);
  const b = normaliseText(candidateName);
  if (!a || !b) return false;
  const prefixLen = Math.min(GATE_DESC_PREFIX_LEN, a.length, b.length);
  if (prefixLen > 0 && a.slice(0, prefixLen) === b.slice(0, prefixLen)) return true;
  if (similarity(a, b) >= GATE_DESC_TRIGRAM_FLOOR) return true;
  return false;
}

function priceAgrees(
  stagedUnitPrice: number | null,
  catalogPrice: number | null
): boolean {
  // Missing catalog_price is NOT a reason to reject - the gate check
  // is "where a catalog_price exists" per §2.3.
  if (catalogPrice == null) return true;
  if (stagedUnitPrice == null) return true;
  if (catalogPrice <= 0) return true;
  const ratio = stagedUnitPrice / catalogPrice;
  const low = 1 - GATE_PRICE_WITHIN_PCT;
  const high = 1 + GATE_PRICE_WITHIN_PCT;
  return ratio >= low && ratio <= high;
}

export async function POST(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  let body: {
    offset?: number;
    dryRun?: boolean;
    vendor?: string;
    invoiceNumber?: string;
  };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  // dryRun defaults TRUE. Opt-in to writing requires an explicit
  // dryRun=false in the body, or ?dryRun=false (or ?dryRun=0) on the
  // query string. Any other input, including no body at all, dry-runs.
  const dryRunQ = req.nextUrl.searchParams.get("dryRun");
  const dryRun =
    body.dryRun === false
      ? false
      : !(dryRunQ === "false" || dryRunQ === "0");
  const offset = Math.max(0, Number(body.offset ?? 0));
  const vendorFilter = typeof body.vendor === "string" ? body.vendor.trim() : null;
  const invoiceNumberFilter =
    typeof body.invoiceNumber === "string" ? body.invoiceNumber.trim() : null;

  const client = serviceClient();

  // --- Pick a batch of distinct base invoices. Each base is read as
  // an independent unit so the correction overlay and the submission
  // pick are scoped per invoice.
  //
  // base_invoice_number is a generated column on pr_rescan_lines
  // (0010 §identity): regexp_replace(invoice_number, '-R[0-9]+$', '').
  // A correction landing under <inv>-R2 shares its base with the
  // original row at <inv>.
  //
  // M2 R5: apply_status taxonomy.
  //   RETRYABLE
  //     'pending'  - never attempted
  //     'conflict' - attempted, OUR code failed mid-apply; retry when
  //                  the defect is fixed
  //   TERMINAL
  //     'filled'      - a blank was filled with a gated value
  //     'corrected'   - a non-null value was replaced, corroborated
  //     'skipped'     - deliberate no-op (equal, fill-only on populated,
  //                     or every field null)
  //     'unmatched'   - attempted, no pairing cleared the floor
  //     'rejected'    - attempted, the item_number gate refused the SKU
  //     'annotation'  - reconciliation row, never a data line
  //
  // Selection filters to RETRYABLE only. Terminal rows must not be
  // reconsidered; retryable rows must not be abandoned. The M1 build
  // filtered to 'pending' alone, which made the 110 conflict rows left
  // behind by the R1 defect permanently unreachable - 149 planned
  // merges that never re-entered the candidate set. Measured
  // 2026-11-05 live.
  const RETRYABLE_STATUSES = ["pending", "conflict"];
  // PostgrestFilterBuilder.eq() returns a NEW builder - reassign to
  // chain the conditional filters cleanly.
  let basesQuery = client
    .from("pr_rescan_lines")
    .select("base_invoice_number")
    .in("apply_status", RETRYABLE_STATUSES)
    .order("base_invoice_number", { ascending: true });
  if (vendorFilter) basesQuery = basesQuery.eq("vendor", vendorFilter);
  if (invoiceNumberFilter)
    basesQuery = basesQuery.eq("base_invoice_number", invoiceNumberFilter);
  // M1 R2: ALWAYS take the first N pending distinct bases. offset is
  // kept in the body for backward compat (callers may still pass it)
  // but it is ignored for selection. In the first live run, page 2
  // requested offset=25 against a pending set that live writes had
  // just shrunk, found zero rows there, and reported done - leaving
  // 116 lines across 5 invoices unprocessed. The fix is to not
  // paginate by offset over a mutating set at all; the caller loops
  // until `done: true`, which only fires when pending is empty.
  //
  // Pull a wide range so a single response's distinctBases is a good
  // over-estimate of pending invoices for the `remaining` field.
  const { data: candidatesData, error: candidatesErr } = await basesQuery.range(
    0,
    1999
  );
  if (candidatesErr) {
    return NextResponse.json({ error: candidatesErr.message }, { status: 500 });
  }
  const distinctBases: string[] = [];
  const seen = new Set<string>();
  for (const r of (candidatesData ?? []) as Array<{ base_invoice_number: string }>) {
    if (!r.base_invoice_number) continue;
    if (seen.has(r.base_invoice_number)) continue;
    seen.add(r.base_invoice_number);
    distinctBases.push(r.base_invoice_number);
  }
  const basesInBatch = distinctBases.slice(0, BATCH);
  // M2 R7: exact `remaining`. The range fetch above caps at 2,000 rows
  // (~130 distinct bases for 882 staged rows, ~450 for ~3,100 staged).
  // The priority manifest is 152 invoices across 309 pages, which
  // will stage several thousand rows; past 2,000 retryable rows
  // `remaining` derived from distinctBases would silently under-report
  // and the caller could stop early believing it was done. One extra
  // head:true count query makes it exact.
  const { count: retryableRowCount, error: countErr } = await client
    .from("pr_rescan_lines")
    .select("*", { count: "exact", head: true })
    .in("apply_status", RETRYABLE_STATUSES);
  if (countErr) {
    return NextResponse.json({ error: countErr.message }, { status: 500 });
  }
  // `remaining` is distinct RETRYABLE bases this call saw but did not
  // process. Derived from distinctBases.length (accurate up to the
  // range fetch cap); retryableRowCount surfaces separately below as
  // a second independent signal.
  const remaining = Math.max(0, distinctBases.length - basesInBatch.length);
  // M3 R8: terminate on PROGRESS, not an absolute count.
  //
  // Pre-M3 done was `retryableRowCount === 0`. That cannot fire under
  // dryRun (no status ever writes, so the count is a constant), so a
  // paged dry run looped forever: six identical pages on 2026-11-05
  // before Kevin's own guard killed it. And a LIVE run is not safe
  // either - any row that stays retryable after being attempted (e.g.
  // the 110 conflict rows from the first live run) keeps the count
  // non-zero and the route re-selects the same invoices, hammering
  // ai_line_items and pr_events in a tight loop.
  //
  // Two conditions, both needed:
  //
  //   (1) sawLessThanBatch: this call selected fewer bases than the
  //       batch size, so it has seen every retryable base there is.
  //       True in dryRun and live alike; needs no writes.
  //
  //   (2) stalled: a full batch with no status transitions. Under
  //       dryRun this is structural (nothing writes), so the first
  //       full-batch call terminates - the caller is not told "no
  //       progress" twice. Under live it catches a batch where every
  //       attempted row stayed retryable. Reported in the response.
  //
  // retryableRows stays in the response - it is exact and useful
  // signal. It just does not decide termination.
  const sawLessThanBatch = basesInBatch.length < BATCH;
  // rowsStatusTransitioned is counted during per-invoice processing
  // below; it is the number of pr_rescan_lines rows whose status was
  // actually written away from a retryable state this call. Under
  // dryRun it stays 0 by construction.
  let rowsStatusTransitioned = 0;

  // Accumulators for the response.
  const counts = {
    invoices: { considered: 0, corroborated: 0, notCorroborated: 0 },
    lines: { matched: 0, unmatched: 0, annotation: 0, addedByCorrection: 0 },
    fields: {
      filled: {} as Record<string, number>,
      corrected: {} as Record<string, number>,
      skipped: 0,
      rejected: { byReason: {} as Record<string, number> },
    },
    spend: {
      wouldIncrease: 0,
      wouldDecrease: 0,
      netDelta: 0,
      byVendor: new Map<string, { delta: number; invoices: number }>(),
    },
    merges: {
      planned: 0,
      byPrecedence: {} as Record<string, number>,
      conflicts: [] as MergeConflict[],
    },
  };
  const topChanges: TopChange[] = [];
  // M1 R1 rehearsal + R3.2 structural-mismatch + R3.1 invoice errors.
  const batchMergePlans: MergePlan[] = [];
  const structuralMismatch: StructuralMismatch[] = [];
  const invoiceErrors: Array<{ invoice: string; where: string; error: string }> = [];

  for (const baseInv of basesInBatch) {
    counts.invoices.considered += 1;

    // --- Load all staged rows for this base (base + any -R corrections).
    const { data: stagedData, error: stagedErr } = await client
      .from("pr_rescan_lines")
      .select(
        "id,invoice_number,base_invoice_number,is_correction,visual_order,page,vendor,description_seen,item_number,pack_count,pack_size_text,pack_raw,pack_confidence,uom,qty_ordered,qty_shipped,unit_price_seen,extended_price_seen,catch_weight,notes,apply_status"
      )
      .eq("base_invoice_number", baseInv);
    if (stagedErr) {
      return NextResponse.json({ error: stagedErr.message }, { status: 500 });
    }
    const stagedRows = (stagedData ?? []) as StagedLine[];
    if (stagedRows.length === 0) continue;

    // --- L1 §2.1: resolve revisions. The base row at each visual_order
    // is the authoritative target; any -R correction with the same
    // visual_order overlays its non-null fields onto that base. A
    // correction at a visual_order with no base row is unmatched (it
    // can never attach to an ai_line_items line since we cannot know
    // which of the base's lines it was meant to amend).
    // Keyed by `${page}::${visual_order}` - visual_order alone is NOT unique
    // within an invoice (it restarts per page), so keying on it would overlay
    // a correction onto whichever page's line happened to be stored last.
    const baseByOrder = new Map<string, StagedLine>();
    const corrections: StagedLine[] = [];
    const annotations: StagedLine[] = [];
    const orphanCorrections: StagedLine[] = [];
    for (const r of stagedRows) {
      if (isAnnotationShape(r)) {
        annotations.push(r);
        continue;
      }
      if (r.is_correction) corrections.push(r);
      else baseByOrder.set(`${r.page}::${r.visual_order}`, r);
    }
    // Overlay corrections onto bases; track orphans separately.
    const effectiveLines: StagedLine[] = [];
    // Tracks which staged row's id to write apply_status against for
    // each effective line - the base row owns the status for this
    // (page, visual_order) pair, with corrections marked 'skipped'
    // after they land.
    const stagedIdsFor = new Map<string, string[]>();
    for (const [pvo, base] of baseByOrder) {
      let effective = base;
      const applied: string[] = [];
      for (const c of corrections) {
        if (`${c.page}::${c.visual_order}` !== pvo) continue;
        effective = overlayCorrection(effective, c);
        applied.push(c.id);
      }
      effectiveLines.push(effective);
      stagedIdsFor.set(effective.id, [effective.id, ...applied]);
    }
    // M3 R10: discriminate orphan corrections by page, not order.
    // A correction whose page has NO base records at all is an ADDITION
    // (the base read missed a whole page), not a mis-keyed correction.
    // Promote it into effectiveLines so it matches and applies like any
    // other base row. If the page has base records but this exact
    // (page, visual_order) has none, keep the old behaviour - unmatched
    // with reason - because guessing which base line it was meant to
    // amend would be worse than skipping.
    //
    // Measured 2026-11-05: a vendor invoice had 14 page-2 records
    // emitted on the -R2 suffix while the original base covered only
    // page 1. Pre-M3 those records were silently discarded.
    const basePages = new Set<number>();
    for (const base of baseByOrder.values()) {
      if (base.page != null) basePages.add(base.page);
    }
    for (const c of corrections) {
      if (baseByOrder.has(`${c.page}::${c.visual_order}`)) continue;
      // c.page null is treated as "page-level unknown"; keep as orphan
      // rather than promote. The annotation path already removed the
      // reconciliation rows upstream, so this is a defensive branch.
      if (c.page != null && !basePages.has(c.page)) {
        // New page with no base records - treat the correction as a
        // base. Matches like any base line; status comes from the
        // correction row itself.
        effectiveLines.push(c);
        stagedIdsFor.set(c.id, [c.id]);
        counts.lines.addedByCorrection += 1;
      } else {
        orphanCorrections.push(c);
      }
    }

    // Record annotations and orphan corrections immediately (they do
    // not participate in matching). Writes happen at the end under
    // the single dryRun guard.
    const outcomes: LineOutcome[] = [];
    for (const a of annotations) {
      outcomes.push({
        stagedId: a.id,
        status: "annotation",
        reason: "reconciliation annotation (visual_order=99 with all data fields null)",
        matchedLineId: null,
        matchedVendorItemId: null,
        fieldOutcomes: {},
        deltaExtendedPrice: 0,
      });
      counts.lines.annotation += 1;
    }
    for (const o of orphanCorrections) {
      outcomes.push({
        stagedId: o.id,
        status: "unmatched",
        reason: "no base record at this visual_order",
        matchedLineId: null,
        matchedVendorItemId: null,
        fieldOutcomes: {},
        deltaExtendedPrice: 0,
      });
      counts.lines.unmatched += 1;
    }

    // --- L1 §2.2: pick the live submission for the invoice number.
    // order by (status='corrected'), submitted_at desc -- first row
    // is the live submission. 34 of 754 manifest rows pointed at a
    // 'corrected' submission; reading that one has cost us a day.
    //
    // invoice_submissions is a non-pr_ table; serviceClient bypasses
    // RLS. Shape: invoice_number (text), status (text nullable),
    // submitted_at (timestamptz), total_amount (numeric).
    let submissionTotal: number | null = null;
    let liveSubmissionId: string | null = null;
    {
      const { data: subs, error: subErr } = await client
        .from("invoice_submissions")
        .select("id,status,submitted_at,total_amount")
        .eq("invoice_number", baseInv)
        .limit(50);
      if (subErr) {
        return NextResponse.json({ error: subErr.message }, { status: 500 });
      }
      const rows = (subs ?? []) as Array<{
        id: string;
        status: string | null;
        submitted_at: string | null;
        total_amount: number | string | null;
      }>;
      rows.sort((a, b) => {
        const aCorr = (a.status ?? "") === "corrected" ? 1 : 0;
        const bCorr = (b.status ?? "") === "corrected" ? 1 : 0;
        if (aCorr !== bCorr) return aCorr - bCorr; // non-corrected first
        const ta = a.submitted_at ?? "";
        const tb = b.submitted_at ?? "";
        return tb.localeCompare(ta); // submitted_at desc
      });
      if (rows.length > 0) {
        liveSubmissionId = rows[0].id;
        if (rows[0].total_amount != null) {
          const n = Number(rows[0].total_amount);
          submissionTotal = Number.isFinite(n) ? n : null;
        }
      }
    }

    // M1 R3.1: `proceedToMatching` replaces the pre-M1 `continue`
    // statements so the end-of-invoice stamp block (annotation batch,
    // unmatched batch grouped by reason, defensive sweep) always runs.
    // Pre-M1, a null-submission or structural-mismatch invoice skipped
    // the sweep and left annotations/orphans at 'pending'.
    let proceedToMatching = true;

    // L3: no submission for this invoice number -> mark every staged
    // line 'unmatched' and skip matching. A silent fallback to
    // invoice_number is how the superseded-submission bug survived
    // review; do not reintroduce it. Measured 2026-11-05 on a 27-invoice
    // batch: filtering on invoice_number pulled 1,012 rows where only
    // 780 were live (232 stale across 5 invoices).
    if (liveSubmissionId == null) {
      for (const line of effectiveLines) {
        outcomes.push({
          stagedId: line.id,
          status: "unmatched",
          reason: "no submission found for invoice number",
          matchedLineId: null,
          matchedVendorItemId: null,
          fieldOutcomes: {},
          deltaExtendedPrice: 0,
        });
        counts.lines.unmatched += 1;
      }
      proceedToMatching = false;
    }

    // L3: filter on invoice_uuid, NOT invoice_number. An invoice number
    // can carry several submissions and the superseded ones hold stale
    // values. On the 27-invoice batch of 2026-11-05, invoice_number
    // loaded 1,012 rows where only 780 were live - 232 stale rows
    // across 5 invoices, which produced false corrections against a
    // dead baseline and would have written to rows nothing reads.
    let storedLines: AiLine[] = [];
    if (proceedToMatching) {
      const { data: aiData, error: aiErr } = await client
        .from("ai_line_items")
        .select(
          "id,vendor_name,invoice_number,invoice_date,line_num,description,quantity,unit,unit_price,extended_price,item_number,pack_size,uom_raw,parsed_pack_qty,catch_weight_marker"
        )
        .eq("invoice_uuid", liveSubmissionId);
      if (aiErr) {
        return NextResponse.json({ error: aiErr.message }, { status: 500 });
      }
      storedLines = (aiData ?? []) as AiLine[];
    }

    // --- M1 R3.2: structural line-count mismatch.
    // When staged and stored line counts differ by both an absolute gap
    // (>= STRUCTURAL_MIN_GAP) and a ratio (>= STRUCTURAL_MIN_RATIO),
    // field-level matching cannot repair the invoice - our capture has
    // the wrong NUMBER of lines, not just wrong values. Classify only:
    // stamp every staged line 'unmatched' with reason "structural
    // line-count mismatch; needs line-set replacement" and report the
    // invoice in structuralMismatch for Kevin to decide. Do NOT write
    // a line-set replacement path here; that is a separate
    // authorisation.
    if (proceedToMatching) {
      const nStagedPre = effectiveLines.length;
      const nStoredPre = storedLines.length;
      const minN = Math.min(nStagedPre, nStoredPre);
      const maxN = Math.max(nStagedPre, nStoredPre);
      const gapPre = maxN - minN;
      const ratioPre = minN > 0 ? maxN / minN : Number.POSITIVE_INFINITY;
      if (
        nStagedPre > 0 &&
        gapPre >= STRUCTURAL_MIN_GAP &&
        ratioPre >= STRUCTURAL_MIN_RATIO
      ) {
        const stagedSumPre = effectiveLines.reduce(
          (acc, r) => acc + (r.extended_price_seen ?? 0),
          0
        );
        const storedSumPre = storedLines.reduce(
          (acc, r) => acc + (Number(r.extended_price) || 0),
          0
        );
        structuralMismatch.push({
          invoice: baseInv,
          stagedLines: nStagedPre,
          storedLines: nStoredPre,
          printedTotal: submissionTotal,
          stagedSum: Number(stagedSumPre.toFixed(2)),
          storedSum: Number(storedSumPre.toFixed(2)),
        });
        for (const line of effectiveLines) {
          outcomes.push({
            stagedId: line.id,
            status: "unmatched",
            reason: "structural line-count mismatch; needs line-set replacement",
            matchedLineId: null,
            matchedVendorItemId: null,
            fieldOutcomes: {},
            deltaExtendedPrice: 0,
          });
          counts.lines.unmatched += 1;
        }
        proceedToMatching = false;
      }
    }

    // --- L1 §2.4 corroboration: sum(staged extended_price_seen)
    // compared to invoice_submissions.total_amount. A gap equal to a
    // printed tax figure is a reconciliation, not a defect - treat
    // the invoice as corroborated when the line sum equals the header
    // total OR when the shortfall is named in a `notes` field as tax.
    let corroborated = false;
    if (proceedToMatching) {
      const lineSum = effectiveLines.reduce(
        (acc, r) => acc + (r.extended_price_seen ?? 0),
        0
      );
      const gap =
        submissionTotal != null
          ? Number((submissionTotal - lineSum).toFixed(2))
          : null;
      const exactMatch =
        submissionTotal != null && Math.abs(gap ?? 0) <= CORROBORATION_CENT_TOLERANCE;
      const notesMentionTax = stagedRows.some(
        (r) => r.notes != null && RECONCILIATION_TAX_RE.test(r.notes)
      );
      corroborated =
        submissionTotal == null
          ? false
          : exactMatch || (gap != null && gap > 0 && notesMentionTax);
      if (corroborated) counts.invoices.corroborated += 1;
      else counts.invoices.notCorroborated += 1;
    }

    // --- L1 §2.2: assignment. Runs only when proceedToMatching;
    // L3 null-submission and R3.2 structural-mismatch paths already
    // populated outcomes for this invoice and bypass matching.
    const matchedPairs: Array<{ staged: StagedLine; stored: AiLine }> = [];
    if (proceedToMatching) {
      const nStaged = effectiveLines.length;
      const nStored = storedLines.length;
      const scoreMatrix: number[][] = [];
      const floorMatrix: boolean[][] = [];
      for (let i = 0; i < nStaged; i++) {
        const row: number[] = new Array(nStored).fill(0);
        const floors: boolean[] = new Array(nStored).fill(false);
        for (let j = 0; j < nStored; j++) {
          const r = scorePair(effectiveLines[i], storedLines[j]);
          row[j] = r.score;
          floors[j] = r.passesFloor;
        }
        scoreMatrix.push(row);
        floorMatrix.push(floors);
      }
      const pairing = assignByScore(scoreMatrix, floorMatrix);

      // Partition staged lines by match result.
      const unmatchedStaged: StagedLine[] = [];
      for (let i = 0; i < nStaged; i++) {
        if (pairing[i] === -1) {
          unmatchedStaged.push(effectiveLines[i]);
        } else {
          const stored = storedLines[pairing[i]];
          matchedPairs.push({ staged: effectiveLines[i], stored });
        }
      }

      for (const s of unmatchedStaged) {
        outcomes.push({
          stagedId: s.id,
          status: "unmatched",
          reason:
            "no stored line passed the match floor (exact extended_price or trigram >= 0.55)",
          matchedLineId: null,
          matchedVendorItemId: null,
          fieldOutcomes: {},
          deltaExtendedPrice: 0,
        });
        counts.lines.unmatched += 1;
      }
    }

    // M1 R3.1: do NOT `continue` here on empty matchedPairs - the
    // end-of-invoice stamp block + defensive sweep must always run so
    // annotations and orphans get stamped and nothing is left pending.
    if (matchedPairs.length > 0) {

    // --- Vendor resolution. ai_line_items.vendor_name is the
    // authoritative vendor label; pr_vendor_items is keyed off a
    // canonical pr_vendors row that may have different capitalisation
    // or an alias. Look up all vendor_ids this invoice can touch.
    const vendorNames = Array.from(
      new Set(
        matchedPairs
          .map((p) => (p.stored.vendor_name ?? "").trim())
          .filter((v) => v.length > 0)
      )
    );
    const vendorIdByName = new Map<string, string>();
    if (vendorNames.length > 0) {
      const { data: vData, error: vErr } = await client
        .from("pr_vendors")
        .select("id,name")
        .in("name", vendorNames);
      if (vErr) {
        return NextResponse.json({ error: vErr.message }, { status: 500 });
      }
      for (const r of (vData ?? []) as Array<{ id: string; name: string }>) {
        vendorIdByName.set(r.name, r.id);
      }
      const unresolved = vendorNames.filter((n) => !vendorIdByName.has(n));
      if (unresolved.length > 0) {
        const { data: aData, error: aErr } = await client
          .from("pr_vendor_aliases")
          .select("vendor_id,alias_text")
          .in("alias_text", unresolved);
        if (aErr) {
          return NextResponse.json({ error: aErr.message }, { status: 500 });
        }
        for (const r of (aData ?? []) as Array<{ vendor_id: string; alias_text: string }>) {
          vendorIdByName.set(r.alias_text, r.vendor_id);
        }
      }
    }

    // --- Look up pr_vendor_items via pr_price_observations.line_id.
    // This is the canonical ai_line_item -> pr_vendor_items path. When
    // a staged line's matched ai_line is not yet in pr_price_observations
    // (intake not run for that line), fall back to a vendor-scoped SKU
    // or description-key lookup.
    const lineIds = matchedPairs.map((p) => p.stored.id);
    const vendorItemByLineId = new Map<string, string>();
    if (lineIds.length > 0) {
      for (let i = 0; i < lineIds.length; i += 500) {
        const slice = lineIds.slice(i, i + 500);
        const { data: obsData, error: obsErr } = await client
          .from("pr_price_observations")
          .select("line_id,vendor_item_id")
          .in("line_id", slice);
        if (obsErr) {
          return NextResponse.json({ error: obsErr.message }, { status: 500 });
        }
        for (const r of (obsData ?? []) as Array<{
          line_id: string;
          vendor_item_id: string;
        }>) {
          vendorItemByLineId.set(r.line_id, r.vendor_item_id);
        }
      }
    }
    const resolvedVendorItemIds = Array.from(new Set(vendorItemByLineId.values()));
    const vendorItemById = new Map<string, VendorItem>();
    if (resolvedVendorItemIds.length > 0) {
      for (let i = 0; i < resolvedVendorItemIds.length; i += 500) {
        const slice = resolvedVendorItemIds.slice(i, i + 500);
        const { data: viData, error: viErr } = await client
          .from("pr_vendor_items")
          .select(
            "id,vendor_id,item_number,item_number_norm,description_key,name,status,link_status,ingredient_id,pack_override,flagged,flag_note,flagged_by,grade"
          )
          .in("id", slice);
        if (viErr) {
          return NextResponse.json({ error: viErr.message }, { status: 500 });
        }
        for (const r of (viData ?? []) as VendorItem[]) {
          vendorItemById.set(r.id, r);
        }
      }
    }

    // --- Per-matched-pair processing.
    for (const { staged, stored } of matchedPairs) {
      counts.lines.matched += 1;
      const outcome: LineOutcome = {
        stagedId: staged.id,
        status: "skipped",
        reason: null,
        matchedLineId: stored.id,
        matchedVendorItemId: vendorItemByLineId.get(stored.id) ?? null,
        fieldOutcomes: {},
        deltaExtendedPrice: 0,
      };

      const vendorName = stored.vendor_name ?? staged.vendor ?? null;
      const vendorId = vendorName ? vendorIdByName.get(vendorName) ?? null : null;
      const vendorItem = outcome.matchedVendorItemId
        ? vendorItemById.get(outcome.matchedVendorItemId) ?? null
        : null;

      // --- Gate the item_number before any field decision.
      let gateResult: GateResult = { pass: false, reason: "existence" };
      const stagedSku = normaliseSku(staged.item_number);
      if (stagedSku && vendorId) {
        // (1) Existence: pr_vendor_items first (prefer own purchase
        // history), then pr_vendor_catalog.
        const { data: viMatchData, error: viMatchErr } = await client
          .from("pr_vendor_items")
          .select("id,name")
          .eq("vendor_id", vendorId)
          .eq("item_number_norm", stagedSku)
          .limit(1);
        if (viMatchErr) {
          return NextResponse.json({ error: viMatchErr.message }, { status: 500 });
        }
        const viMatch = (viMatchData ?? [])[0] as
          | { id: string; name: string | null }
          | undefined;
        let catalogHit: CatalogHit | null = null;
        if (!viMatch) {
          const { data: catData, error: catErr } = await client
            .from("pr_vendor_catalog")
            .select("vendor_id,item_number_norm,clean_name,pack_text,catalog_price")
            .eq("vendor_id", vendorId)
            .eq("item_number_norm", stagedSku)
            .limit(1);
          if (catErr) {
            return NextResponse.json({ error: catErr.message }, { status: 500 });
          }
          const c = (catData ?? [])[0] as CatalogHit | undefined;
          if (c) catalogHit = c;
        }
        if (!viMatch && !catalogHit) {
          gateResult = { pass: false, reason: "existence" };
        } else {
          // (2) Description agrees: 30-char prefix OR trigram >= 0.75
          // against the candidate name.
          const candidateName = viMatch?.name ?? catalogHit?.clean_name ?? null;
          const descOk = descriptionAgrees(staged.description_seen, candidateName);
          if (!descOk) {
            gateResult = { pass: false, reason: "description" };
          } else {
            // (3) Price agrees within 15% when a catalog_price exists.
            // §2.3: "A catalog_price that disagrees with the invoice
            // price is DISQUALIFYING, not confirming."
            const catPrice = catalogHit?.catalog_price ?? null;
            const priceOk = priceAgrees(staged.unit_price_seen, catPrice);
            if (!priceOk) {
              gateResult = { pass: false, reason: "price" };
            } else {
              gateResult = {
                pass: true,
                source: viMatch ? "vendor_item" : "catalog",
                vendorItemId: viMatch?.id,
              };
            }
          }
        }
      } else if (!stagedSku) {
        // Staged has no SKU at all - nothing to gate; item_number
        // field becomes a no-op below.
        gateResult = { pass: false, reason: "existence" };
      }

      // --- Per-field decisions.
      // §2.4: four decision branches per field:
      //   ours empty + staged present + gate passed -> filled
      //   ours present + equal                       -> skipped
      //   ours present + different + corroborated    -> corrected
      //   ours present + different + not corroborated -> conflict
      // item_number only writes when the gate passes; other fields
      // skip the gate (the gate is about the SKU specifically).
      type Fill = {
        field: FieldName;
        column: string; // ai_line_items column name
        before: unknown;
        after: unknown;
        outcome: FieldOutcome;
        reason: string | null;
      };
      const fills: Fill[] = [];

      const equal = (a: unknown, b: unknown): boolean => {
        if (a == null && b == null) return true;
        if (a == null || b == null) return false;
        if (typeof a === "number" && typeof b === "number") {
          return Math.abs(a - b) < 1e-6;
        }
        return String(a).trim().toUpperCase() === String(b).trim().toUpperCase();
      };

      // L4: `fillOnly` means a populated stored column is NEVER overwritten
      // from the staged value. Used when ours is composed/normalised and CC's
      // value is a strict subset in a different representation - overwriting
      // would degrade the column. `pack_size` is the current case
      // ('4/250CT' composed vs '250CT' size-half-only).
      const fieldSpecs: Array<{
        field: FieldName;
        column: string;
        stagedValue: unknown;
        storedValue: unknown;
        gated: boolean;
        fillOnly?: boolean;
      }> = [
        {
          field: "item_number",
          column: "item_number",
          stagedValue: staged.item_number,
          storedValue: stored.item_number,
          gated: true,
        },
        {
          // pack_count is the count-per-case (the `4` in `4/10 LB`). It lands
          // in ai_line_items.parsed_pack_qty, which is empty on all 9,271
          // no-SKU lines - measured 2026-11-05. pack_size_text goes to
          // pack_size separately, so the two halves of the pack land in two
          // columns and neither overwrites the other.
          field: "pack_count",
          column: "parsed_pack_qty",
          stagedValue: staged.pack_count,
          storedValue: stored.parsed_pack_qty,
          gated: false,
        },
        {
          // FILL ONLY. Our pack_size holds the COMPOSED pack ('4/250CT');
          // CC's pack_size_text holds only the size half ('250CT') because
          // the count goes to pack_count -> parsed_pack_qty. Overwriting a
          // populated pack_size therefore DELETES the count: 140 of 750
          // matched lines, measured 2026-11-05. Filling an empty one is
          // correct, because parsed_pack_qty carries the count alongside.
          field: "pack_size_text",
          column: "pack_size",
          stagedValue: staged.pack_size_text,
          storedValue: stored.pack_size,
          gated: false,
          fillOnly: true,
        },
        {
          // Our `unit` column is normalised long-form ('case', 'each', 'pound')
          // and populated on 9,255 of 9,271 lines. CC reports the invoice's
          // printed abbreviation ('CS', 'EA', 'LB') because the spec forbids
          // normalising. Writing CC's value into `unit` would de-normalise 431
          // of 750 matched lines - measured 2026-11-05. `uom_raw` is the column
          // for a printed abbreviation and is empty on 9,074 lines, so that is
          // the only target.
          field: "uom",
          column: "uom_raw",
          stagedValue: staged.uom,
          storedValue: stored.uom_raw,
          gated: false,
        },
        // qty_ordered is deliberately NOT in this list. ai_line_items has one
        // quantity column and it holds the SHIPPED/billed figure, which is
        // qty_shipped's target below. Ordered and shipped differ on partial
        // deliveries (28 lines in the 2026-11-05 batch), and writing ordered
        // over shipped would have corrupted 50 of 750 matched lines. The value
        // is preserved on pr_rescan_lines.qty_ordered and in `raw`.
        {
          field: "qty_shipped",
          column: "quantity",
          stagedValue: staged.qty_shipped,
          storedValue: stored.quantity,
          gated: false,
        },
        {
          field: "unit_price_seen",
          column: "unit_price",
          stagedValue: staged.unit_price_seen,
          storedValue: stored.unit_price,
          gated: false,
        },
        {
          field: "extended_price_seen",
          column: "extended_price",
          stagedValue: staged.extended_price_seen,
          storedValue: stored.extended_price,
          gated: false,
        },
      ];

      for (const spec of fieldSpecs) {
        if (spec.gated && !gateResult.pass) {
          const r = (gateResult as { reason: string }).reason;
          fills.push({
            field: spec.field,
            column: spec.column,
            before: spec.storedValue,
            after: spec.stagedValue,
            outcome: "rejected",
            reason: `gate:${r}`,
          });
          continue;
        }
        if (spec.stagedValue == null) {
          // nothing to write
          fills.push({
            field: spec.field,
            column: spec.column,
            before: spec.storedValue,
            after: spec.stagedValue,
            outcome: "skipped",
            reason: null,
          });
          continue;
        }
        if (spec.storedValue == null) {
          fills.push({
            field: spec.field,
            column: spec.column,
            before: spec.storedValue,
            after: spec.stagedValue,
            outcome: "filled",
            reason: null,
          });
          continue;
        }
        // L4: fill-only field whose stored value is populated. Our column
        // holds a composed/normalised representation and CC's value is a
        // strict subset in a different shape; overwriting would degrade
        // the column. Skip without ever entering the correct/conflict
        // branches below, regardless of corroboration.
        if (spec.fillOnly) {
          fills.push({
            field: spec.field,
            column: spec.column,
            before: spec.storedValue,
            after: spec.stagedValue,
            outcome: "skipped",
            reason: "fill-only field; stored value already composed",
          });
          continue;
        }
        if (equal(spec.storedValue, spec.stagedValue)) {
          fills.push({
            field: spec.field,
            column: spec.column,
            before: spec.storedValue,
            after: spec.stagedValue,
            outcome: "skipped",
            reason: null,
          });
          continue;
        }
        // Differ. §2.4: correct only when the invoice corroborates CC
        // over us. Corroboration is a per-invoice fact computed above
        // (lineSum vs submissionTotal, with sales-tax-named-in-notes
        // allowance).
        if (corroborated) {
          fills.push({
            field: spec.field,
            column: spec.column,
            before: spec.storedValue,
            after: spec.stagedValue,
            outcome: "corrected",
            reason: null,
          });
        } else {
          fills.push({
            field: spec.field,
            column: spec.column,
            before: spec.storedValue,
            after: spec.stagedValue,
            outcome: "conflict",
            reason: "staged differs and header total does not corroborate",
          });
        }
      }

      // --- Aggregate per-field outcomes and spend delta.
      for (const f of fills) {
        outcome.fieldOutcomes[f.field] = f.outcome;
        if (f.outcome === "filled") {
          counts.fields.filled[f.field] = (counts.fields.filled[f.field] ?? 0) + 1;
        } else if (f.outcome === "corrected") {
          counts.fields.corrected[f.field] = (counts.fields.corrected[f.field] ?? 0) + 1;
        } else if (f.outcome === "skipped") {
          counts.fields.skipped += 1;
        } else if (f.outcome === "rejected") {
          const key = f.reason ?? "rejected";
          counts.fields.rejected.byReason[key] =
            (counts.fields.rejected.byReason[key] ?? 0) + 1;
        }
        if (f.field === "extended_price_seen" && f.outcome === "corrected") {
          const before = asNumber(f.before) ?? 0;
          const after = asNumber(f.after) ?? 0;
          const delta = after - before;
          outcome.deltaExtendedPrice = delta;
          if (delta > 0) counts.spend.wouldIncrease += delta;
          else counts.spend.wouldDecrease += -delta;
          counts.spend.netDelta += delta;
          const vn = vendorName ?? "(unknown vendor)";
          const existing = counts.spend.byVendor.get(vn) ?? { delta: 0, invoices: 0 };
          existing.delta += delta;
          counts.spend.byVendor.set(vn, existing);
        }
        // Collect top-50 candidates on absolute-value basis.
        if (f.outcome === "filled" || f.outcome === "corrected") {
          let deltaAbs = 0;
          if (typeof f.before === "number" && typeof f.after === "number") {
            deltaAbs = Math.abs(f.after - f.before);
          } else if (f.before == null && f.after != null) {
            deltaAbs = typeof f.after === "number" ? Math.abs(f.after) : 1;
          }
          topChanges.push({
            invoiceNumber: baseInv,
            vendor: vendorName,
            field: f.field,
            before: f.before,
            after: f.after,
            deltaAbs,
          });
        }
      }

      // Overall status per staged row: 'corrected' if any field was
      // corrected, else 'filled' if any filled, else 'skipped' if any
      // skipped and nothing else, else 'rejected'/'conflict' if those
      // exist. Precedence tracks severity.
      const overallHas = {
        corrected: fills.some((f) => f.outcome === "corrected"),
        filled: fills.some((f) => f.outcome === "filled"),
        rejected: fills.some((f) => f.outcome === "rejected"),
        conflict: fills.some((f) => f.outcome === "conflict"),
        skipped: fills.some((f) => f.outcome === "skipped"),
      };
      if (overallHas.corrected) outcome.status = "corrected";
      else if (overallHas.filled) outcome.status = "filled";
      else if (overallHas.conflict) outcome.status = "conflict";
      else if (overallHas.rejected) outcome.status = "rejected";
      else outcome.status = "skipped";

      // --- L1 §2.5 + M3 R9: pr_vendor_items merge planning.
      //
      // Pre-M3, the collision check only fired when the route was ABOUT
      // TO WRITE a SKU (filled or corrected). After the first live run
      // on 2026-11-05, 149 collision plans were built; the live write
      // then succeeded on ai_line_items for those 149 fields, so the
      // second run classifies them 'skipped' (stored already equals
      // staged) and the collision path never fires. The 149 duplicate
      // pr_vendor_items rows are still there, still needing a merge,
      // and the only code path that saw them has gone dark.
      //
      // M3 R9 decouples: a line whose item_number is 'skipped BECAUSE
      // stored equals staged' (both non-null, equal) is just as much
      // evidence of a catalog duplicate as a line that would have
      // written. Run the collision check for that case too. Only the
      // ai_line_items write is redundant; the catalog reconciliation
      // is not.
      //
      // R9.4 (noted, not built): state-based duplicate reconciliation
      // belongs in its own pass over pr_vendor_items, independent of
      // whether any invoice was re-read. This loader-driven version
      // is a recovery path; the durable shape is a separate work item.
      let mergePlan: MergePlan | null = null;
      const itemNumberFill = fills.find((f) => f.field === "item_number");
      const storedSku = normaliseSku(stored.item_number);
      const willWriteSku =
        itemNumberFill != null &&
        (itemNumberFill.outcome === "filled" || itemNumberFill.outcome === "corrected");
      // R9 branch: outcome was skipped because stored equals staged. Not
      // 'skipped because null' and not 'skipped because fillOnly'; the
      // equal-and-non-null case specifically.
      const skuMatchSkipped =
        itemNumberFill != null &&
        itemNumberFill.outcome === "skipped" &&
        stagedSku != null &&
        storedSku != null &&
        stagedSku === storedSku;
      if ((willWriteSku || skuMatchSkipped) && vendorItem && stagedSku && vendorId) {
        // Does any OTHER row at this vendor already hold this SKU?
        // (vendor_id, item_number_norm) is covered by the dedup_key
        // n: branch which is UNIQUE per (vendor_id, dedup_key).
        const { data: collisionData, error: collisionErr } = await client
          .from("pr_vendor_items")
          .select(
            "id,vendor_id,item_number,item_number_norm,description_key,name,status,link_status,ingredient_id,pack_override,flagged,flag_note,flagged_by,grade"
          )
          .eq("vendor_id", vendorId)
          .eq("item_number_norm", stagedSku)
          .neq("id", vendorItem.id)
          .limit(1);
        if (collisionErr) {
          return NextResponse.json({ error: collisionErr.message }, { status: 500 });
        }
        const other = (collisionData ?? [])[0] as VendorItem | undefined;
        if (other) {
          // Merge is needed. Apply the precedence rules of §2.5.
          const rank = (ls: string): number =>
            ls === "confirmed" ? 2 : ls === "proposed" ? 1 : 0;
          const rA = rank(vendorItem.link_status);
          const rB = rank(other.link_status);
          const sameIngredient =
            vendorItem.ingredient_id &&
            other.ingredient_id &&
            vendorItem.ingredient_id === other.ingredient_id;
          const differsOnIngredient =
            !!vendorItem.ingredient_id &&
            !!other.ingredient_id &&
            vendorItem.ingredient_id !== other.ingredient_id;
          let survivor = vendorItem.id;
          let absorbed = other.id;
          if (rB > rA) {
            survivor = other.id;
            absorbed = vendorItem.id;
          } else if (rA === rB) {
            // Tie on link_status. Our row (vendorItem) is the one the
            // ai_line_items line already points to via the observation,
            // so it is the natural survivor. §2.5 rule 1 reads: "A
            // human decision beats a machine one"; a tie carries no
            // human signal to break it, so the natural keeper wins.
            survivor = vendorItem.id;
            absorbed = other.id;
          }
          const precedence: MergePlan["precedence"] =
            rA === 2 && rB === 2 ? "equal-confirmed"
            : rA === 2 || rB === 2 ? "confirmed>proposed"
            : rA === 1 && rB === 1 ? "equal-none"
            : rA === 1 || rB === 1 ? "proposed>none"
            : "equal-none";
          // Both participating rows are in scope right here (`vendorItem`
          // and `other`); setting them on the plan removes the L1 bug
          // where the executor relied on a batch-level map lookup that
          // never cached `other`.
          const survivorRow = survivor === vendorItem.id ? vendorItem : other;
          const absorbedRow = absorbed === vendorItem.id ? vendorItem : other;
          mergePlan = {
            aId: vendorItem.id,
            bId: other.id,
            aRow: vendorItem,
            bRow: other,
            survivor,
            absorbed,
            survivorRow,
            absorbedRow,
            precedence,
            differsOnIngredient: !sameIngredient && differsOnIngredient,
            ingredientA: vendorItem.ingredient_id,
            ingredientB: other.ingredient_id,
          };
          if (mergePlan.differsOnIngredient && rA === 2 && rB === 2) {
            // §2.5 rule 4: BOTH confirmed to DIFFERENT masters. Stop.
            counts.merges.conflicts.push({
              vendorItemIdA: mergePlan.aId,
              vendorItemIdB: mergePlan.bId,
              ingredientA: mergePlan.ingredientA,
              ingredientB: mergePlan.ingredientB,
              // best-effort usd figure for the conflict report
              usd: 0,
            });
            // Mark line as conflict - do NOT write anything.
            outcome.status = "conflict";
            outcome.reason = "pr_vendor_items merge: both confirmed to different ingredient_ids";
            // Override item_number outcome
            if (itemNumberFill) itemNumberFill.outcome = "conflict";
          } else {
            counts.merges.planned += 1;
            counts.merges.byPrecedence[precedence] =
              (counts.merges.byPrecedence[precedence] ?? 0) + 1;
            // M1 R1: plans go into the batch pool so the dry-run
            // rehearsal can run them through the same resolver the
            // live executor uses. In live mode the rehearsal is still
            // valid work - it confirms nothing regressed since planning.
            batchMergePlans.push(mergePlan);
          }
        }
      }

      outcomes.push(outcome);

      // --- Live writes. All gates on dryRun land here; one guard,
      // one place to read for the acceptance review (§6).
      if (!dryRun) {
        // (a) ai_line_items corrections.
        // One UPDATE per staged row; the apply pass is not hot enough
        // to need a batched write. Only the fields that decided
        // 'filled' or 'corrected' are set.
        const aiUpdate: Record<string, unknown> = {};
        const beforeAi: Record<string, unknown> = {};
        const afterAi: Record<string, unknown> = {};
        for (const f of fills) {
          if (f.outcome !== "filled" && f.outcome !== "corrected") continue;
          // (L4: qty_ordered no longer has a fieldSpec, so no prioritisation
          // is needed - qty_shipped is the only writer of `quantity`.)
          aiUpdate[f.column] = f.after;
          beforeAi[f.field] = f.before;
          afterAi[f.field] = f.after;
          // (L4: `uom` now targets uom_raw directly via its fieldSpec. `unit`
          // is normalised and must never be written from CC's printed
          // abbreviation.)
        }
        if (Object.keys(aiUpdate).length > 0) {
          const { error: aiUpErr } = await client
            .from("ai_line_items")
            .update(aiUpdate)
            .eq("id", stored.id);
          if (aiUpErr) {
            // Non-fatal to the batch - record a conflict on this line.
            outcome.status = "conflict";
            outcome.reason = `ai_line_items update failed: ${aiUpErr.message}`;
          } else {
            // M1 R4: kind reflects whether ANY field in the event
            // carried a prior non-null that changed. A row that filled
            // four blanks and also corrected a price was being logged
            // as rescan_filled because the decision was wired to
            // item_number alone; this made the audit log unsearchable
            // for "what did we change the money on". `fills` already
            // carries the per-field outcome; any 'corrected' there is
            // the stronger claim. Pure-fill rows (all filled, no
            // corrected) stay rescan_filled.
            const anyCorrected = fills.some(
              (f) => f.outcome === "corrected"
            );
            await client.from("pr_events").insert({
              entity_type: "ai_line_item",
              entity_id: stored.id,
              kind: anyCorrected ? "rescan_corrected" : "rescan_filled",
              before: beforeAi,
              after: afterAi,
              actor: "rescan-apply",
              note: `base=${baseInv}; staged=${staged.id}`,
            });
          }
        }

        // (b) pr_vendor_items corrections (item_number re-key + merge).
        // M3 R9: execute the planned merge regardless of whether a
        // SKU write is also warranted. Pre-M3 this sat INSIDE the
        // `if (willWriteSku)` branch, so a skuMatchSkipped line
        // that revealed a catalog collision at planning time never
        // triggered the merge. §2.5 order of operations unchanged:
        //   1. carry human curation onto the survivor (never clobber
        //      pack_override; carry flagged/flag_note/flagged_by,
        //      grade, and ingredient_id when the survivor lacks them)
        //   2. re-point pr_price_observations.vendor_item_id,
        //      pr_golden_links.vendor_item_id, and
        //      pr_vendor_item_aliases.vendor_item_id from absorbed
        //      to survivor
        //   3. mark absorbed row duplicate_of_id + status +
        //      link_status so it leaves the queue
        //   4. re-aggregate survivor counters from
        //      pr_price_observations (never sum the two cached
        //      counters - that double-counts if both have run)
        //   5. emit pr_events('rescan_merge') with both rows'
        //      pre-write state in `before`
        if (
          mergePlan &&
          !mergePlan.differsOnIngredient &&
          vendorItem &&
          stagedSku
        ) {
          // M1 R1: resolve participants from the plan via the shared
          // resolver. Both rows are set at plan-build time; the pre-M1
          // code reached into a batch-level vendorItemById map that
          // never cached the collision candidate and so returned
          // undefined on all 149 plans.
          const participants = resolveMergeParticipants(mergePlan);
          if (!participants.ok) {
            outcome.status = "conflict";
            outcome.reason = `merge participants not loaded: ${participants.reason}`;
          } else {
            const { survivor, absorbed } = participants;
            const mergeOk = await executeMergePlan(client, survivor, absorbed);
            if (!mergeOk.ok) {
              outcome.status = "conflict";
              outcome.reason = `merge failed: ${mergeOk.error}`;
            } else if (willWriteSku) {
              // M3 R9: only re-key the survivor when a fresh SKU
              // write was warranted. skuMatchSkipped lines already
              // carry the SKU on both sides; the merge collapsed the
              // duplicate rows, nothing to re-key.
              const { error: survUpErr } = await client
                .from("pr_vendor_items")
                .update({ item_number: staged.item_number })
                .eq("id", survivor.id);
              if (survUpErr) {
                outcome.status = "conflict";
                outcome.reason = `survivor re-key failed after merge: ${survUpErr.message}`;
              }
            }
          }
        } else if (willWriteSku && vendorItem && stagedSku) {
          // No collision at plan time. §2.5 race recheck immediately
          // before the write (defence against another writer having
          // inserted between the planning query and this point) and
          // direct pr_vendor_items re-key. Only fires when the field
          // outcome was fill or correct; a skuMatchSkipped line with
          // no collision has nothing to do here.
          const { data: raceData, error: raceErr } = await client
            .from("pr_vendor_items")
            .select("id")
            .eq("vendor_id", vendorItem.vendor_id)
            .eq("item_number_norm", stagedSku)
            .neq("id", vendorItem.id)
            .limit(1);
          if (raceErr) {
            return NextResponse.json({ error: raceErr.message }, { status: 500 });
          }
          if ((raceData ?? []).length > 0) {
            outcome.status = "conflict";
            outcome.reason = "pr_vendor_items collision detected at write time (race)";
          } else {
            const { error: viUpErr } = await client
              .from("pr_vendor_items")
              .update({ item_number: staged.item_number })
              .eq("id", vendorItem.id);
            if (viUpErr) {
              outcome.status = "conflict";
              outcome.reason = `pr_vendor_items re-key failed: ${viUpErr.message}`;
            }
          }
        }

        // (c) Update the staged row's apply_status. The dryRun guard
        // sits at the top of this block; this write only fires in
        // live mode. apply_reason carries the stage/explanation; the
        // base row and any overlay correction rows share the same
        // apply_status (corrections are rolled into the effective
        // line so their write is informational only).
        const stagedIds = stagedIdsFor.get(staged.id) ?? [staged.id];
        const applyUpdate = {
          apply_status: outcome.status,
          apply_reason: outcome.reason,
          applied_at: new Date().toISOString(),
          matched_line_id: outcome.matchedLineId,
          matched_vendor_item_id: outcome.matchedVendorItemId,
        };
        const { error: stagedUpErr } = await client
          .from("pr_rescan_lines")
          .update(applyUpdate)
          .in("id", stagedIds);
        if (stagedUpErr) {
          // M1 R3.1: do not swallow. Record the failure against the
          // invoice; the end-of-invoice defensive sweep below stamps
          // any still-pending row so it does not get silently retried.
          invoiceErrors.push({
            invoice: baseInv,
            where: `per-pair-status staged=${staged.id}`,
            error: stagedUpErr.message,
          });
        } else if (outcome.status !== "conflict") {
          // M3 R8: count transitions away from retryable. Outcome.status
          // produced here is one of filled | corrected | skipped |
          // rejected | conflict | annotation | unmatched - RETRYABLE_STATUSES
          // at the DB level is pending|conflict; outcomes never yield
          // 'pending', so 'conflict' is the only retryable value. Every
          // other outcome retires the row.
          rowsStatusTransitioned += stagedIds.length;
        }
      }
    }
    } // end `if (matchedPairs.length > 0)`

    // --- Mark annotations and orphans in live mode too.
    // M1 R3.1: group unmatched outcomes by reason so a response
    // claiming "unmatched: N" writes that same reason to the DB for
    // each row - not "the first unmatched row's reason" copied across
    // all N, which previously overwrote structural-mismatch reasons
    // with "no stored line passed the match floor" and left mixed
    // sets inconsistent with the response.
    if (!dryRun) {
      const annotationUpdates = outcomes.filter((o) => o.status === "annotation");
      if (annotationUpdates.length > 0) {
        const { error: annErr } = await client
          .from("pr_rescan_lines")
          .update({
            apply_status: "annotation",
            apply_reason:
              "reconciliation annotation (visual_order=99 with all data fields null)",
            applied_at: new Date().toISOString(),
          })
          .in(
            "id",
            annotationUpdates.map((o) => o.stagedId)
          );
        if (annErr) {
          invoiceErrors.push({
            invoice: baseInv,
            where: "annotation-batch-stamp",
            error: annErr.message,
          });
        } else {
          // M3 R8: annotation is terminal.
          rowsStatusTransitioned += annotationUpdates.length;
        }
      }
      const unmatchedUpdates = outcomes.filter((o) => o.status === "unmatched");
      if (unmatchedUpdates.length > 0) {
        const byReason = new Map<string, string[]>();
        for (const o of unmatchedUpdates) {
          const key = o.reason ?? "unmatched";
          const list = byReason.get(key) ?? [];
          list.push(o.stagedId);
          byReason.set(key, list);
        }
        for (const [reason, ids] of byReason) {
          const { error: unmErr } = await client
            .from("pr_rescan_lines")
            .update({
              apply_status: "unmatched",
              apply_reason: reason,
              applied_at: new Date().toISOString(),
            })
            .in("id", ids);
          if (unmErr) {
            invoiceErrors.push({
              invoice: baseInv,
              where: `unmatched-batch-stamp (reason=${reason})`,
              error: unmErr.message,
            });
          } else {
            // M3 R8: unmatched is terminal.
            rowsStatusTransitioned += ids.length;
          }
        }
      }

      // M1 R3.1 defensive sweep: any staged row for this invoice still
      // 'pending' after the route considered it is a silent failure in
      // one of the writes above. Stamp it with a reason naming the
      // sweep so it does not get retried forever. Zero on a clean run.
      const { data: stillPending, error: sweepReadErr } = await client
        .from("pr_rescan_lines")
        .select("id")
        .eq("base_invoice_number", baseInv)
        .eq("apply_status", "pending");
      if (sweepReadErr) {
        invoiceErrors.push({
          invoice: baseInv,
          where: "defensive-sweep-read",
          error: sweepReadErr.message,
        });
      } else if ((stillPending ?? []).length > 0) {
        const ids = (stillPending as Array<{ id: string }>).map((r) => r.id);
        const { error: sweepErr } = await client
          .from("pr_rescan_lines")
          .update({
            apply_status: "unmatched",
            apply_reason:
              "considered but no outcome recorded (defensive sweep)",
            applied_at: new Date().toISOString(),
          })
          .in("id", ids);
        if (sweepErr) {
          invoiceErrors.push({
            invoice: baseInv,
            where: "defensive-sweep-write",
            error: sweepErr.message,
          });
        } else {
          invoiceErrors.push({
            invoice: baseInv,
            where: "defensive-sweep",
            error: `${ids.length} row(s) stamped unmatched after being left pending`,
          });
          // M3 R8: sweep writes 'unmatched' which is terminal.
          rowsStatusTransitioned += ids.length;
        }
      }
    }

    // Tick byVendor invoice counter once per considered invoice.
    const vendorName = effectiveLines[0]?.vendor ?? null;
    if (vendorName) {
      const existing = counts.spend.byVendor.get(vendorName) ?? { delta: 0, invoices: 0 };
      existing.invoices += 1;
      counts.spend.byVendor.set(vendorName, existing);
    }
  }

  // --- M1 R1 rehearsal. Under dryRun, walk every planned merge
  // through resolveMergeParticipants - the same resolver the live
  // executor uses. groupsNotLoadable > 0 means the resolver would
  // have refused to execute at live time. The pre-M1 build (lookup
  // via vendorItemById that never cached `other`) would have failed
  // this on all 149 plans; the post-M1 build sets both rows on the
  // plan at build time and passes every plan.
  let rehearsal: {
    groupsLoadable: number;
    groupsNotLoadable: number;
    firstFailures: Array<{ aId: string; bId: string; reason: string }>;
  } | null = null;
  if (dryRun) {
    rehearsal = {
      groupsLoadable: 0,
      groupsNotLoadable: 0,
      firstFailures: [],
    };
    for (const plan of batchMergePlans) {
      const r = resolveMergeParticipants(plan);
      if (r.ok) {
        rehearsal.groupsLoadable += 1;
      } else {
        rehearsal.groupsNotLoadable += 1;
        if (rehearsal.firstFailures.length < 5) {
          rehearsal.firstFailures.push({
            aId: plan.aId,
            bId: plan.bId,
            reason: r.reason,
          });
        }
      }
    }
  }

  // --- Response assembly.
  topChanges.sort((a, b) => b.deltaAbs - a.deltaAbs);
  const top50 = topChanges.slice(0, 50);
  const byVendorArr = Array.from(counts.spend.byVendor.entries()).map(
    ([vendor, v]) => ({
      vendor,
      delta: Number(v.delta.toFixed(2)),
      invoices: v.invoices,
    })
  );

  // M3 R8: compute done from progress (not retryableRowCount, which
  // cannot fire under dryRun). Two terminating conditions:
  //   (1) sawLessThanBatch - every retryable base has been offered to
  //       this call, there is no next page to fetch.
  //   (2) stalled - this call saw a full batch and produced zero
  //       status transitions. Under dryRun this is structural (the
  //       `if (!dryRun)` guard around the writes makes
  //       rowsStatusTransitioned 0), so the first full-batch dry-run
  //       call terminates. Under live it means every attempted row
  //       stayed retryable; the caller should stop rather than loop.
  const stalled = !sawLessThanBatch && rowsStatusTransitioned === 0;
  const done = sawLessThanBatch || stalled;

  const response = {
    dryRun,
    offset,
    nextOffset: offset + basesInBatch.length,
    // M3 R8: done terminates on PROGRESS. See computation above.
    // `remaining` is the distinct retryable bases this call saw but
    // did not process (progress reporting); `retryableRows` is the
    // authoritative table-wide count (independent signal); `stalled`
    // surfaces the second termination branch so the caller can tell
    // "finished the queue" (sawLessThanBatch) apart from "live run
    // made no progress" (stalled && !sawLessThanBatch).
    done,
    stalled,
    remaining,
    retryableRows: retryableRowCount ?? 0,
    invoices: counts.invoices,
    lines: counts.lines,
    fields: {
      filled: counts.fields.filled,
      corrected: counts.fields.corrected,
      skipped: counts.fields.skipped,
      rejected: counts.fields.rejected,
    },
    spend: {
      wouldIncrease: Number(counts.spend.wouldIncrease.toFixed(2)),
      wouldDecrease: Number(counts.spend.wouldDecrease.toFixed(2)),
      netDelta: Number(counts.spend.netDelta.toFixed(2)),
      byVendor: byVendorArr,
    },
    merges: {
      planned: counts.merges.planned,
      byPrecedence: counts.merges.byPrecedence,
      conflicts: counts.merges.conflicts,
      ...(rehearsal ? { rehearsed: rehearsal } : {}),
    },
    // M1 R3.2: structural line-count mismatches reported, never fixed.
    structuralMismatch,
    structuralMismatchThresholds: {
      minGap: STRUCTURAL_MIN_GAP,
      minRatio: STRUCTURAL_MIN_RATIO,
    },
    // M1 R3.1: any staged-row write that failed, including the
    // defensive sweep's own result.
    invoiceErrors,
    top50,
  };
  return NextResponse.json(response);
}

// L1 §2.5 merge executor. Implements rules 1-7. Returns {ok:true} on
// success or {ok:false, error} on failure; the caller surfaces the
// error as a per-line conflict.
async function executeMergePlan(
  client: SupabaseClient,
  survivor: VendorItem,
  absorbed: VendorItem
): Promise<{ ok: true } | { ok: false; error: string }> {
  // (1) + (2): carry human curation onto the survivor. Never clobber
  // pack_override - the pack backfill already honours this, and we
  // must too. flagged/flag_note/flagged_by, grade, and ingredient_id
  // come from whichever side holds a confirmed decision.
  //
  // We read the survivor row again to check live state before write.
  const { data: survLive, error: survLiveErr } = await client
    .from("pr_vendor_items")
    .select("pack_override,flagged,flag_note,flagged_by,grade,ingredient_id")
    .eq("id", survivor.id)
    .maybeSingle();
  if (survLiveErr) return { ok: false, error: survLiveErr.message };
  const survivorCuration = (survLive ?? {}) as {
    pack_override: unknown;
    flagged: boolean | null;
    flag_note: string | null;
    flagged_by: string | null;
    grade: string | null;
    ingredient_id: string | null;
  };
  const carry: Record<string, unknown> = {};
  // Never overwrite an existing pack_override.
  // Carry flagged/flag_note/flagged_by onto survivor only when it has none.
  if (
    survivorCuration.flagged !== true &&
    absorbed.flagged === true
  ) {
    carry.flagged = true;
    carry.flag_note = absorbed.flag_note;
    carry.flagged_by = absorbed.flagged_by;
  }
  if (!survivorCuration.grade && absorbed.grade) {
    carry.grade = absorbed.grade;
  }
  if (!survivorCuration.ingredient_id && absorbed.ingredient_id) {
    carry.ingredient_id = absorbed.ingredient_id;
    carry.link_status = absorbed.link_status;
  }
  if (Object.keys(carry).length > 0) {
    const { error: carryErr } = await client
      .from("pr_vendor_items")
      .update(carry)
      .eq("id", survivor.id);
    if (carryErr) return { ok: false, error: carryErr.message };
  }

  // (3) re-point child FKs from absorbed -> survivor.
  //
  // pr_price_observations: no unique constraint on vendor_item_id,
  // straight UPDATE.
  {
    const { error: obsErr } = await client
      .from("pr_price_observations")
      .update({ vendor_item_id: survivor.id })
      .eq("vendor_item_id", absorbed.id);
    if (obsErr) return { ok: false, error: `obs re-point: ${obsErr.message}` };
  }

  // pr_golden_links: UNIQUE on vendor_item_id. If the survivor
  // already has one, the absorbed row's link is the loser (survivor
  // carries the human decision). In that case leave the survivor's
  // link in place; the absorbed one will be left behind but is no
  // longer the keeper for its ingredient_id. If the survivor has
  // none, re-point the absorbed row's link to the survivor.
  {
    const { data: survLink } = await client
      .from("pr_golden_links")
      .select("id")
      .eq("vendor_item_id", survivor.id)
      .maybeSingle();
    if (!survLink) {
      const { error: linkErr } = await client
        .from("pr_golden_links")
        .update({ vendor_item_id: survivor.id })
        .eq("vendor_item_id", absorbed.id);
      if (linkErr) return { ok: false, error: `golden_links re-point: ${linkErr.message}` };
    }
    // If both sides have a golden link, we intentionally leave the
    // absorbed link in place (pointing at the now-duplicate row);
    // the data is still readable and nothing is deleted.
  }

  // pr_vendor_item_aliases: UNIQUE on (vendor_item_id,
  // description_norm). Re-point in bulk; collisions (same
  // description_norm on both sides) are handled by reading first and
  // re-pointing only the non-colliding ones. The duplicate alias
  // stays with the absorbed row, unreachable from the survivor but
  // not deleted.
  {
    const { data: survAliases } = await client
      .from("pr_vendor_item_aliases")
      .select("description_norm")
      .eq("vendor_item_id", survivor.id);
    const survSet = new Set(
      ((survAliases ?? []) as Array<{ description_norm: string }>).map((r) => r.description_norm)
    );
    const { data: absAliases } = await client
      .from("pr_vendor_item_aliases")
      .select("id,description_norm")
      .eq("vendor_item_id", absorbed.id);
    const toRepoint = ((absAliases ?? []) as Array<{ id: string; description_norm: string }>)
      .filter((r) => !survSet.has(r.description_norm))
      .map((r) => r.id);
    if (toRepoint.length > 0) {
      const { error: aliasErr } = await client
        .from("pr_vendor_item_aliases")
        .update({ vendor_item_id: survivor.id })
        .in("id", toRepoint);
      if (aliasErr)
        return { ok: false, error: `aliases re-point: ${aliasErr.message}` };
    }
  }

  // (5) mark absorbed row duplicate_of_id + status + link_status.
  // Nothing is deleted per 0002 grants (no DELETE anywhere on pr_
  // tables).
  {
    const { error: absErr } = await client
      .from("pr_vendor_items")
      .update({
        duplicate_of_id: survivor.id,
        status: "duplicate",
        link_status: "rejected",
        link_reason: "rescan_merge:absorbed",
      })
      .eq("id", absorbed.id);
    if (absErr) return { ok: false, error: `absorbed mark: ${absErr.message}` };
  }

  // (6) re-aggregate survivor counters from observations. Never sum
  // the two cached counters - that double-counts if both have run.
  // We recompute lines, lines_12m, usd, usd_12m, accounts,
  // first_seen, last_seen, needs_review_lines from the live
  // pr_price_observations view of the survivor.
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
  const cutoff = twelveMonthsAgo.toISOString().slice(0, 10);
  {
    let lines = 0;
    let lines12 = 0;
    let usd = 0;
    let usd12 = 0;
    let first: string | null = null;
    let last: string | null = null;
    const accountSet = new Set<string>();
    let needsReview = 0;
    let from = 0;
    const page = 1000;
    for (;;) {
      // N0b + 0015: structural exclusion comes from the view; the
      // excluded_reason policy filter comes from applyCountableFilter.
      // The merge recount uses BOTH because the stored counter it
      // feeds (pr_vendor_items.usd via merge) is maintained with the
      // same policy as every other read site.
      const q = client
        .from(COUNTABLE_OBSERVATIONS_VIEW)
        .select("extended_price,invoice_date,account_key,needs_review")
        .eq("vendor_item_id", survivor.id)
        .range(from, from + page - 1);
      const { data: obs, error: obsErr } = await applyCountableFilter(q);
      if (obsErr) return { ok: false, error: `recount: ${obsErr.message}` };
      const rows =
        (obs ?? []) as Array<{
          extended_price: number | null;
          invoice_date: string | null;
          account_key: string | null;
          needs_review: boolean | null;
        }>;
      for (const r of rows) {
        lines += 1;
        if (r.extended_price != null) {
          const n = Number(r.extended_price);
          if (Number.isFinite(n)) usd += n;
        }
        if (r.invoice_date) {
          if (!first || r.invoice_date < first) first = r.invoice_date;
          if (!last || r.invoice_date > last) last = r.invoice_date;
          if (r.invoice_date >= cutoff) {
            lines12 += 1;
            if (r.extended_price != null) {
              const n = Number(r.extended_price);
              if (Number.isFinite(n)) usd12 += n;
            }
          }
        }
        if (r.account_key) accountSet.add(r.account_key);
        if (r.needs_review === true) needsReview += 1;
      }
      if (rows.length < page) break;
      from += page;
    }
    const counterUpdate = {
      lines,
      lines_12m: lines12,
      usd: Number(usd.toFixed(2)),
      usd_12m: Number(usd12.toFixed(2)),
      accounts: Array.from(accountSet),
      first_seen: first,
      last_seen: last,
      needs_review_lines: needsReview,
    };
    const { error: counterErr } = await client
      .from("pr_vendor_items")
      .update(counterUpdate)
      .eq("id", survivor.id);
    if (counterErr) return { ok: false, error: `counter update: ${counterErr.message}` };
  }

  // (7) pr_events('rescan_merge') with both rows' pre-write state in
  // `before`. §6 of the master doc: every new write populates `before`.
  await client.from("pr_events").insert({
    entity_type: "vendor_item",
    entity_id: survivor.id,
    kind: "rescan_merge",
    before: {
      survivor: {
        id: survivor.id,
        link_status: survivor.link_status,
        ingredient_id: survivor.ingredient_id,
        pack_override: survivor.pack_override,
        flagged: survivor.flagged,
        grade: survivor.grade,
      },
      absorbed: {
        id: absorbed.id,
        link_status: absorbed.link_status,
        ingredient_id: absorbed.ingredient_id,
        pack_override: absorbed.pack_override,
        flagged: absorbed.flagged,
        grade: absorbed.grade,
      },
    },
    after: {
      survivor: survivor.id,
      absorbed: absorbed.id,
      status: "merged; absorbed marked duplicate_of_id",
    },
    actor: "rescan-apply",
  });

  return { ok: true };
}

