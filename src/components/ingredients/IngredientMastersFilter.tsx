"use client";

// N12: Ingredients tab = one workspace. Toolbar + two panes filling
// the window below the shell's top bar (desktop) or stacked with a
// phone back-link (<=860). The detail pane is composed from the item
// panel's primitives (kf-ipanel__*):
//   - .kf-ipanel__strip      -> stats strip
//   - .kf-ipanel__attn       -> IssueNote block (+ --good variant)
//   - PanelIngredientZone    -> Name / Category / Costed per / One
//                               each is / Allergens
//   - PanelClosedRows        -> Mark as retail / Merge / Send all
//                               back / Change history
// There is ONE each-measure editor (PanelIngredientZone's "One each
// is" row), ONE BaseUnitControl mount (inside PanelIngredientZone),
// ONE allergen block (inside PanelIngredientZone). The drawer the
// name used to open (IngredientPanelById) is deleted along with its
// chrome="tab" code paths in BaseUnitControl and IngredientAllergens.
//
// Vocabulary: user-facing "master" / "masters" -> "ingredient" /
// "ingredients" everywhere on this tab (N12 §R8). The IdentBand's
// fact labels in IngredientMasters.tsx are a separate ask.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  Check,
} from "lucide-react";
import { Search } from "./Search";
import { SortMenu, type SortKey } from "./SortMenu";
import { toast } from "@/components/ui/Toaster";
import { fmtCount, fmtUsd, fmtUsdLong } from "@/lib/fmt";
import { ItemPanelById } from "./ItemPanelById";
import { DetailPanel } from "./DetailPanel";
import { loadParents as loadParentsFromStore } from "./parentsStore";
import { SUPER_CATEGORIES } from "@/lib/ingredients/categories";
import { canonicalFromBaseUnit, uomLabel } from "@/lib/ingredients/pack";
// M2 §4B amendment 4 + part 3 fix 9: no screen imports deriveRecipePrice
// or the each-measure shapers. The alternate-unit view that the derived
// sub-line used to carry is handled by the expand's chip view switch
// (§2.6) which computes in the browser via priceInUnit.
import {
  factor,
  priceInUnit,
  reachableUnits,
  type Measure,
} from "@/lib/ingredients/measures";
import { SPREAD_RATIO_MAX } from "@/lib/ingredients/blend";
import { postJson, saveErrorSentence } from "./panel/common";
import { packInUseText } from "./panel/packHelpers";
import { fmtPackNumbersInText } from "@/lib/fmt";
import { useSaveWithRefresh } from "./panel/useSaveWithRefresh";
import type { ReviewCardIngredient } from "./itemTypes";
import "./ingredients-tab.css";

// Typed issue surface (ingredient has at least one of these set by
// IngredientMasters.tsx server rollup). "empty" is "no linked items";
// kept here for the badge + filter chip, even though the price
// sub-line already names coverage/spread.
export type MasterIssue = "spread" | "coverage" | "needs_measure" | "sizes_differ" | "outlier" | "band" | "empty";

export type LensStats = {
  avgPerBase: number | null;
  minPerBase: number | null;
  maxPerBase: number | null;
  spreadRatio: number | null;
  pricedCount: number;
  linkedCount: number;
  usd12m: number;
  unpricedUsd: number;
};

export type MasterLinkedItem = {
  id: string;
  name: string;
  vendor: string;
  perBase: number | null;
  perBaseUom: string | null;
  // M2 §2.1/2.6: per-item status + price-in-base-unit + which units
  // the item's price reaches through the ingredient's measures.
  // Replaces unitMismatch.
  statusKind: "in_blend" | "check_it" | "needs_measure" | "sizes_differ";
  perBaseInIngUnit: number | null;
  reach: string[];
  outlier: boolean;
  priceManualOverride: boolean;
  grade: string | null;
  usd12m: number;
  eachMeasure: { qty: number; uom: string } | null;
  // M2 §4B part 3 fix 4+9: pack shape rides on the linked item so the
  // Ingredients-tab panel (same mount) can seed the Measures-block
  // suggestions and the expand's chip view switch can re-price per
  // row via priceInUnit.
  packQty: number | null;
  packSize: number | null;
  packUom: string | null;
  caseWeightLb: number | null;
  // T7 ruling 3: the four columns the loader widened for. itemNumber
  // feeds the search ("Has item number ...") and the Pack column of
  // the linked-items table; lastSeen feeds Last bought; catchWeight
  // labels the sub-line; packText is the pack-as-written echo.
  itemNumber: string | null;
  lastSeen: string | null;
  catchWeight: boolean;
  packText: string | null;
};

export type MasterRow = {
  id: string;
  name: string;
  parent: string | null;
  category: string | null;
  baseUnit: string;
  resale: boolean;
  allergens: string[];
  // T5b item 6: allergensReviewedBy no longer travels. Ingredients /
  // Retail never rendered it.
  allergensReviewedAt: string | null;
  linkedCount: number;
  usd12m: number;
  avgPerBase: number | null;
  minPerBase: number | null;
  maxPerBase: number | null;
  spreadRatio: number | null;
  statsByLens: {
    blended: LensStats;
    standard: LensStats;
    premium: LensStats;
  };
  baseUom: string | null;
  flagged: boolean;
  flagReason: string | null;
  pricedCount: number;
  unpricedUsd: number;
  issues: MasterIssue[];
  suggestedBaseUnit: string | null;
  medianBeforeExclusion: number | null;
  linkedItems: MasterLinkedItem[];
  eachMeasureQty: number | null;
  eachMeasureUom: string | null;
  eachMeasureSource: string | null;
  // M2 §3.7 amendment 1: the Ingredients tab already mounts
  // PanelIngredientZone off MasterRow at ~756, so measures + yield
  // ride on the row - no new wrapper, no new /api/review/ingredient
  // fetch for the basic panel open.
  measures: Array<{ from_unit: string; qty: number; to_unit: string; source: string }>;
  yieldPct: number | null;
  yieldSource: string | null;
};

// Train 5a / F23: the local sort keys are the subset of the shared
// SortKey this tab offers; the dropdown words come from SORT_WORDS
// (one vocabulary across tabs). The internal key "links" retired to
// "items" so it matches the shared word.
type SortMode = Extract<SortKey, "spend" | "name" | "items" | "spread">;
const MASTERS_SORT_OPTIONS: readonly SortMode[] = ["spend", "name", "items", "spread"];

// N12 §R8 + §2b: badges for what the price sub-line cannot say.
// "spread" / "coverage" are dropped - price sub-line names both.
// "empty" renamed "No items".
// M2: "mismatch" renamed "needs_measure", badge "Needs a measure".
const ISSUE_BADGE: Partial<Record<MasterIssue, string>> = {
  needs_measure: "Needs a measure",
  // M2.1 fix 2: sizes_differ had no badge; row rendered with no tag.
  sizes_differ: "Sizes differ",
  outlier: "Outlier",
  band: "Out of band",
  empty: "No items",
};

const BASE_UNIT_WORD: Record<string, string> = {
  lb: "lb", ea: "each", gal: "gal", dozen: "dozen", oz: "oz", kg: "kg", g: "g",
};

function uomOrUnit(uom: string | null): string {
  return uom ? uomLabel(uom) : "unit";
}

// T7 item 5: "A blank is never shown as a fact." The three readers
// below name every empty value in words a person can read, as the
// reference's allergenWords() and reachWords() have them.
function allergenWords(row: MasterRow): string {
  if (row.allergensReviewedAt == null) return "not checked";
  if (!row.allergens || row.allergens.length === 0) return "none";
  return row.allergens.join(", ");
}

function reachWords(row: MasterRow): string {
  const base = canonicalFromBaseUnit(row.baseUnit);
  if (!base) return "any unit";
  const reachable = Array.from(
    reachableUnits([base], { measures: row.measures as Measure[] }),
  );
  if (reachable.length === 0) return `only ${uomLabel(base)}`;
  const order: readonly string[] = ["LB", "OZ", "EA", "FLOZ", "GAL"];
  const picked = order.filter((u) => reachable.includes(u));
  if (picked.length === 0) return `only ${uomLabel(base)}`;
  return picked.map((u) => uomLabel(u)).join(", ");
}

// N12 round 2 fix 14: $0.00 reads as noise next to the pane head's
// "- a year"; prefer "$0". fmtUsd stays untouched for other callers.
function fmtMoney(n: number): string {
  return n === 0 ? "$0" : fmtUsd(n);
}

// T7 ruling 3 + item 5: matchField + matches live in matchField.ts so
// scripts/ can import them under tsx without pulling CSS. The pure
// function returns which field hit; the boolean wrapper is for the
// filter step.
import { matchField, matches, type MasterMatch } from "./matchField";
export { matchField };
export type { MasterMatch };

// N12 §R1: price-sub precedence on the row. First match wins.
// T6 §1: the warn branch of the spread sub-line names the same
// subset the detail-panel banner does. Gated on a populated grade
// subset over threshold (ratioFlag's shape in IngredientMasters.tsx),
// not on the blended figure. Single-grade masters keep the exact
// pre-T6 copy - that subset IS the blend.
function rowPriceSub(row: MasterRow): { text: string; warn: boolean } | null {
  if (row.linkedCount === 0) return null;
  if (row.pricedCount === 0) return { text: "not priced", warn: true };
  if (row.pricedCount < row.linkedCount) {
    return { text: `${fmtCount(row.pricedCount)} of ${fmtCount(row.linkedCount)} priced`, warn: true };
  }
  const std = row.statsByLens.standard;
  const prem = row.statsByLens.premium;
  const stdPop = std.linkedCount > 0;
  const premPop = prem.linkedCount > 0;
  const bothPop = stdPop && premPop;
  const stdOver = stdPop && std.spreadRatio != null && std.spreadRatio > SPREAD_RATIO_MAX;
  const premOver = premPop && prem.spreadRatio != null && prem.spreadRatio > SPREAD_RATIO_MAX;
  if (stdOver || premOver) {
    if (!bothPop) {
      // Single grade: byte-identical to pre-T6. No grade word.
      return { text: `${(row.spreadRatio ?? 0).toFixed(1)}x spread`, warn: true };
    }
    // Two-grade: name the subset. When both are over, name the worse.
    // Drop "spread" here - the 116 px price column ellipses
    // "4.3x Standard spread" (126 px at 800 12 px Mulish). The
    // single-grade branch above keeps "${ratio}x spread" verbatim.
    if (stdOver && premOver) {
      const stdR = std.spreadRatio!;
      const premR = prem.spreadRatio!;
      if (stdR >= premR) {
        return { text: `${stdR.toFixed(1)}x Standard`, warn: true };
      }
      return { text: `${premR.toFixed(1)}x Premium`, warn: true };
    }
    if (stdOver) {
      return { text: `${std.spreadRatio!.toFixed(1)}x Standard`, warn: true };
    }
    return { text: `${prem.spreadRatio!.toFixed(1)}x Premium`, warn: true };
  }
  // M2 §4B amendment 4: the "in recipes" derived sub-line moved to
  // the expand's chip view switch. Row header shows the base_unit
  // price only; alternate units via chip.
  // Includes the pure-grade-gap case (blended > threshold but no
  // subset over): report quietly, no red.
  if (row.spreadRatio != null) {
    return { text: `${row.spreadRatio.toFixed(1)}x spread`, warn: false };
  }
  return null;
}

// M2 §4B amendment 4: stripDerivedSub removed. The chip view switch
// in the expand (§2.6) replaces the "in recipes" sub-line with a
// first-class alternate-unit view computed via priceInUnit.
function stripDerivedSub(_row: MasterRow, _active: LensStats): string | null {
  return null;
}

export function IngredientMastersFilter({
  rows,
  mode = "recipe",
  initialOpenId: _initialOpenId = null,
}: {
  rows: MasterRow[];
  mode?: "recipe" | "resale";
  // T7 ruling 4 retires the server-seeded initialOpenId: the whole
  // address (open, drawer, edit, q, sort, cat, attn, alg, empty,
  // lens, unit) now feeds through useSearchParams, so a reload, a
  // Back and a Forward each return the same screen without a prop.
  initialOpenId?: string | null;
}) {
  const router = useRouter();
  const params = useSearchParams();

  // T7 ruling 4: patch one or more address keys at once. push is the
  // default (clicks add history); replace is for arrow keys / typing
  // / the filter chips / Prev-Next steps / lens + unit. An absent key
  // defaults, so a plain /stockpot/ingredients is a bare URL.
  const push = useCallback(
    (patch: Record<string, string | null>, mode: "push" | "replace" = "push") => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === "") next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      const href = qs ? `?${qs}` : "?";
      if (mode === "replace") router.replace(href);
      else router.push(href);
    },
    [params, router],
  );

  // --- read every key out of the URL (the only source of truth) ---
  const urlOpen = params.get("open");
  const urlDrawer = params.get("drawer");
  const urlEdit = params.get("edit") === "1";
  const urlQ = params.get("q") ?? "";
  const urlSortRaw = params.get("sort");
  const sort: SortMode =
    urlSortRaw === "name" || urlSortRaw === "items" || urlSortRaw === "spread"
      ? urlSortRaw
      : "spend";
  const urlCatRaw = params.get("cat");
  const superCat: string = urlCatRaw && SUPER_CATEGORIES.includes(urlCatRaw as (typeof SUPER_CATEGORIES)[number]) ? urlCatRaw : "all";
  const onlyFlagged = params.get("attn") === "1";
  const onlyUnreviewed = params.get("alg") === "1";
  const onlyEmpty = params.get("empty") === "1";

  // Validate `open` against the loaded rows: an unknown / retired id
  // drops to no-selection, as ruling 4 says.
  const selId = urlOpen && rows.some((r) => r.id === urlOpen) ? urlOpen : null;
  const paneOpen = selId != null;
  const openItemId = urlDrawer;

  // The search input is the only key that holds a local draft: the
  // Search component debounces its commit by 250 ms and the URL only
  // moves after the wait. Mirroring Vendor items.
  const trimmed = urlQ.trim();
  const filtered = useMemo(() => {
    let out = rows;
    if (trimmed) out = out.filter((r) => matches(r, trimmed));
    if (superCat !== "all") out = out.filter((r) => r.category === superCat);
    if (onlyFlagged) out = out.filter((r) => r.issues.length > 0);
    if (onlyUnreviewed) out = out.filter((r) => r.allergensReviewedAt == null);
    if (onlyEmpty) out = out.filter((r) => r.issues.includes("empty"));
    if (sort === "name") out = [...out].sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "items") out = [...out].sort((a, b) => b.linkedCount - a.linkedCount);
    else if (sort === "spread") out = [...out].sort((a, b) => (b.spreadRatio ?? 0) - (a.spreadRatio ?? 0));
    else out = [...out].sort((a, b) => b.usd12m - a.usd12m);
    return out;
  }, [rows, trimmed, superCat, onlyFlagged, onlyUnreviewed, onlyEmpty, sort]);

  // T3 R3-1: selection decided during render, no useEffect in the
  // loop. Round 2's two-state model set the hold in a useEffect,
  // which meant the render that first received the new rows had
  // already painted `filtered[0]` before the effect ran - causing
  // a "Salmon -> Beef -> Salmon" flicker, scrolling the pane back
  // to the top and collapsing any open Merge / measures / history
  // row on every save. R2 also only held when `selId` was set, so
  // the default first row (never clicked) was not held at all.
  //
  // Architecture:
  //   - selId: the user's last click. Stays across filter changes.
  //   - lastShownRef: a ref storing "what we rendered last, under
  //     which filter key". Written during render after `selected` is
  //     computed. Writing a ref during render is allowed for this
  //     "track previous render" pattern; see React docs on ref
  //     cheatsheet. Idempotent within a render, so StrictMode's
  //     double invoke is safe.
  //
  // Decision tree:
  //   1. If the user has clicked a row and that row is in `filtered`,
  //      show it. The click is the clearest signal.
  //   2. Else look at lastShownRef:
  //      a. filter key unchanged (rows changed = save): if last-shown
  //         is still in `rows`, show it. Covers scenario 1 (clicked
  //         then save-outside-filter) AND scenario 2 (default row
  //         then save-outside-filter).
  //      b. filter key changed (user reconfigured): show last-shown
  //         only when it still matches the new filter; else fall
  //         through to filtered[0]. Covers scenarios 3 + 4.
  //   3. Fallback: filtered[0].
  const filterKey = `${trimmed}|${superCat}|${onlyFlagged ? 1 : 0}|${onlyUnreviewed ? 1 : 0}|${onlyEmpty ? 1 : 0}|${sort}`;
  const lastShownRef = useRef<{ filterKey: string; id: string | null }>({
    filterKey: "",
    id: null,
  });
  const selected: MasterRow | null = (() => {
    if (selId) {
      const inFiltered = filtered.find((r) => r.id === selId);
      if (inFiltered) return inFiltered;
    }
    const prev = lastShownRef.current;
    if (prev.id) {
      if (prev.filterKey === filterKey) {
        const inRows = rows.find((r) => r.id === prev.id);
        if (inRows) return inRows;
      } else {
        const inFiltered = filtered.find((r) => r.id === prev.id);
        if (inFiltered) return inFiltered;
      }
    }
    return filtered[0] ?? null;
  })();
  lastShownRef.current = { filterKey, id: selected?.id ?? null };
  const matchedUsd = useMemo(() => filtered.reduce((s, r) => s + r.usd12m, 0), [filtered]);
  const needsCount = useMemo(() => rows.filter((r) => r.issues.length > 0).length, [rows]);
  const unreviewedCount = useMemo(
    () => rows.filter((r) => r.allergensReviewedAt == null).length,
    [rows]
  );
  const emptyCount = useMemo(() => rows.filter((r) => r.issues.includes("empty")).length, [rows]);
  const totalUsd = useMemo(() => rows.reduce((s, r) => s + r.usd12m, 0), [rows]);
  const anyFilterActive =
    trimmed.length > 0 || superCat !== "all" || onlyFlagged || onlyUnreviewed || onlyEmpty;

  // T7 ruling 4: clearAll wipes every filter + search in one patch.
  function clearAll() {
    push({ q: null, cat: null, attn: null, alg: null, empty: null }, "replace");
  }

  // When the user picks a row that lives in the filtered set, scroll
  // the list to it (nearest), ignoring vertical page scroll.
  const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  useEffect(() => {
    if (!selId) return;
    const el = rowRefs.current.get(selId);
    el?.scrollIntoView({ block: "nearest" });
  }, [selId]);

  // T7 ruling 4 + R2 item 7: a click pushes (new history); arrow
  // keys replace. Opening the drawer or the item panel pushes;
  // CLOSING either replaces, so Back lands on the previous
  // selection rather than reopening the panel the user just closed.
  // Opening either also drops the other key in the same patch so
  // the two are never both in the address.
  function selectRow(id: string, mode: "push" | "replace" = "push") {
    push({ open: id }, mode);
  }
  // T7 fix 1: when the drawer or the item panel opens from the
  // DEFAULT view (nothing clicked yet; the list shows its first
  // row via `selected`), the address has no `open` key. The
  // cleanup effect below used to read `selId` - "`open`, resolved"
  // - and drop `edit` + `drawer` whenever `selId` was empty,
  // which closed the panel the user just opened about 1.4 s
  // later. The fix: write the shown ingredient's id into `open`
  // AT THE MOMENT of opening, so by the time the effect runs,
  // the state is already "an ingredient is in the address, the
  // panel has reason to be open." A copied link then shows the
  // same ingredient to everyone (chosen over "leave `open`
  // blank and let the next person land on whichever row is
  // first"; the memo decided this).
  function openEditor() {
    const patch: Record<string, string | null> = { edit: "1", drawer: null };
    if (!urlOpen && selected) patch.open = selected.id;
    push(patch);
  }
  function closeEditor() {
    push({ edit: null }, "replace");
  }
  function openItemPanel(id: string) {
    const patch: Record<string, string | null> = { drawer: id, edit: null };
    if (!urlOpen && selected) patch.open = selected.id;
    push(patch);
  }
  function closeItemPanel() {
    push({ drawer: null }, "replace");
  }
  function stepItemPanel(nextId: string) {
    push({ drawer: nextId }, "replace");
  }

  // T7 R2 item 7 + T7 fix 1: scrub INVALID address state only.
  // Three cases that qualify as invalid:
  //   1. `open` names an id that does not resolve (unknown or
  //      retired). Drop `open` + the two dependents. `selId` is
  //      only set when `open` resolves, so (urlOpen && !selId)
  //      is the signal.
  //   2. No ingredient is on screen at all (empty filter result,
  //      or no rows at all): `edit` + `drawer` have nothing to
  //      attach to. The signal here is `selected == null` (NOT
  //      `selId == null` - the default view has selected set to
  //      the first row even without urlOpen; dropping on !selId
  //      is the fault this fix mends).
  //   3. Both `edit` and `drawer` set at once: edit wins, drawer
  //      drops. (Ruling: the two never show together.)
  // The useEffect reads `selected?.id` so a filter change that
  // leaves the list empty is caught too.
  const selectedIdRef = selected?.id ?? null;
  useEffect(() => {
    const patch: Record<string, string | null> = {};
    let dirty = false;
    if (urlOpen && urlOpen !== selId) {
      patch.open = null;
      dirty = true;
      if (urlEdit) patch.edit = null;
      if (urlDrawer) patch.drawer = null;
    } else if (!selectedIdRef) {
      if (urlEdit) { patch.edit = null; dirty = true; }
      if (urlDrawer) { patch.drawer = null; dirty = true; }
    } else if (urlEdit && urlDrawer) {
      patch.drawer = null;
      dirty = true;
    }
    if (dirty) push(patch, "replace");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlOpen, selId, urlEdit, urlDrawer, selectedIdRef]);

  // Parent options for the Category row's "pick existing" select
  // inside PanelIngredientZone (same shape the drawer provided).
  const parentOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.parent) set.add(r.parent);
    return Array.from(set).sort();
  }, [rows]);

  // Build a ReviewCardIngredient from the selected MasterRow so the
  // panel zone + closed rows read the exact shape they already do.
  const selectedIngredient: ReviewCardIngredient | null = useMemo(() => {
    if (!selected) return null;
    return {
      id: selected.id,
      name: selected.name,
      parent: selected.parent,
      category: selected.category,
      resale: selected.resale,
      base_unit: selected.baseUnit,
      allergens: selected.allergens,
      // T5b item 6: the shape going into the panel loses the address.
      allergens_reviewed_at: selected.allergensReviewedAt,
      each_measure_qty: selected.eachMeasureQty,
      each_measure_uom: selected.eachMeasureUom,
      each_measure_source: selected.eachMeasureSource,
      // M2 §4B part 2: measures + yield ride on the ingredient
      // (MasterRow already carries them via IngredientMasters).
      measures: selected.measures,
      yieldPct: selected.yieldPct,
      yieldSource: selected.yieldSource,
      // Polish round 2 fix 2: the blended lens's $ / base_unit comes
      // straight off the MasterRow (buildLensStats already computed
      // it). Attention's outlier head reads this.
      blendedAvgPerBase: selected.statsByLens.blended.avgPerBase,
    };
  }, [selected]);

  // T4 §2a + T3 R2-1: lazy loader for Merge candidates reads through
  // the shared parentsStore cache (one fetch per page life across
  // the drawer and this detail pane), and the useCallback is keyed
  // on `selected?.id` rather than `selected`. The object identity
  // of `selected` flips on every router.refresh (new MasterRow
  // references), which was emptying the Merge picker through
  // PanelClosedRows's downstream useEffect. Keying on the id keeps
  // the callback reference stable across refreshes of the same
  // ingredient, so the cache keeps hitting.
  const selectedId = selected?.id ?? null;
  const loadParents = useCallback(async (): Promise<ReviewCardIngredient[]> => {
    if (!selectedId) return [];
    return loadParentsFromStore(selectedId);
  }, [selectedId]);

  // T7 R2 item 2: Send back + Undo.
  // - One press, one post: the row's SendBackCell owns busy state
  //   and disables its own button while onSendBack is in flight.
  // - A failed Send back says so in the row (train 2's three
  //   sentences) and fires no toast (PR78: a failure that has a
  //   place in the page fires no toast). The button comes back.
  // - Undo works for as long as its toast is shown, wherever the
  //   person is. The toast captures the item and the ingredient
  //   at the moment of the click (closure); the previous
  //   generation check is gone - the toaster already dismisses
  //   its own undo handle when the toast closes.
  async function onSendBack(
    itemId: string,
    itemName: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!selectedId) return { ok: false, error: "Nothing was saved." };
    const ingredientAtClickId = selectedId;
    const r = await postJson("/api/review/undo", { itemId });
    if (!r.ok) {
      return { ok: false, error: saveErrorSentence(r) ?? "Nothing was saved." };
    }
    router.refresh();
    toast(`Sent ${itemName} back`, {
      tone: "good",
      undo: async () => {
        const u = await postJson("/api/review/confirm", {
          ingredientId: ingredientAtClickId,
          itemIds: [itemId],
        });
        if (!u.ok) throw new Error(saveErrorSentence(u) ?? "Nothing was saved.");
        router.refresh();
      },
    });
    return { ok: true };
  }

  return (
    <div className={`kf-ingp__workspace${paneOpen ? " kf-ingp__workspace--detail-open" : ""}`}>
      {/* --- Toolbar (T7 R2 item 3 - ported from part C's
          .kf-toolbar): one row of search + Sort + count, the next
          of category chips alongside Show-only switches. */}
      <div className="kf-ingp__tools">
        <div className="kf-ingp__tools-row">
          <Search
            kind="debounced"
            initial={urlQ}
            onCommit={(v) => push({ q: v.trim() || null }, "replace")}
            placeholder={
              mode === "resale"
                ? "Filter retail by name, linked vendor or SKU"
                : "Filter by name, parent, category, linked vendor or SKU"
            }
            label="Filter ingredients"
          />
          <SortMenu
            value={sort}
            options={MASTERS_SORT_OPTIONS}
            onChange={(v) => push({ sort: v === "spend" ? null : v }, "replace")}
          />
          {anyFilterActive ? (
            <span className="kf-ingp__tools-count" role="status">
              <b>{fmtCount(filtered.length)}</b> of <b>{fmtCount(rows.length)}</b>{" "}
              {mode === "resale" ? "retail " : ""}
              {rows.length === 1 ? "ingredient" : "ingredients"}
            </span>
          ) : (
            <span className="kf-ingp__tools-count" role="status">
              <b>{fmtCount(rows.length)}</b>{" "}
              {mode === "resale" ? "retail " : ""}
              {rows.length === 1 ? "ingredient" : "ingredients"}
            </span>
          )}
        </div>
        <div className="kf-ingp__tools-row kf-ingp__tools-row--chips">
          <div className="kf-chip-row" role="radiogroup" aria-label="Category filter">
            <button
              type="button"
              role="radio"
              aria-checked={superCat === "all"}
              className={`kf-chip${superCat === "all" ? " kf-chip--on" : ""}`}
              onClick={() => push({ cat: null }, "replace")}
            >
              All <span>{fmtCount(rows.length)}</span>
            </button>
            {SUPER_CATEGORIES.map((cat) => {
              const n = rows.filter((r) => r.category === cat).length;
              if (n === 0) return null;
              return (
                <button
                  key={cat}
                  type="button"
                  role="radio"
                  aria-checked={superCat === cat}
                  className={`kf-chip${superCat === cat ? " kf-chip--on" : ""}`}
                  onClick={() => push({ cat }, "replace")}
                >
                  {cat} <span>{fmtCount(n)}</span>
                </button>
              );
            })}
          </div>
          {/* T7 R2 item 8: these three are independent switches, not
              radio buttons. role="group" (not radiogroup). */}
          <div className="kf-chip-row" role="group" aria-label="Show only">
            <button
              type="button"
              aria-pressed={onlyFlagged}
              className={`kf-chip kf-chip--warn${onlyFlagged ? " kf-chip--on" : ""}`}
              onClick={() => push({ attn: onlyFlagged ? null : "1" }, "replace")}
              title="Ingredients with a spread, coverage, unit or outlier issue"
            >
              Needs attention <span>{fmtCount(needsCount)}</span>
            </button>
            <button
              type="button"
              aria-pressed={onlyUnreviewed}
              className={`kf-chip${onlyUnreviewed ? " kf-chip--on" : ""}`}
              onClick={() => push({ alg: onlyUnreviewed ? null : "1" }, "replace")}
              title="Ingredients whose Top 9 allergens have not been checked"
            >
              Allergens to check <span>{fmtCount(unreviewedCount)}</span>
            </button>
            <button
              type="button"
              aria-pressed={onlyEmpty}
              className={`kf-chip${onlyEmpty ? " kf-chip--on" : ""}`}
              onClick={() => push({ empty: onlyEmpty ? null : "1" }, "replace")}
              title="Ingredients with no live vendor items (candidates to retire)"
            >
              No items <span>{fmtCount(emptyCount)}</span>
            </button>
            {anyFilterActive ? (
              <button
                type="button"
                className="kf-chip"
                onClick={clearAll}
              >
                Clear
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {/* --- Panes --------------------------------------------- */}
      <div className={`kf-ingp__panes${paneOpen ? " kf-ingp__panes--detail-open" : ""}`}>
        {/* List pane - T7 R2 item 3: a slim head carries the spend
            total; Sort + the count moved to the toolbar above
            (per vIngToolbar()). The list below has a column
            header row of its own. */}
        <section className="kf-ingp__pane kf-ingp__pane--list" aria-label="Ingredient list">
          <div className="kf-ingp__list-head">
            <span className="kf-ingp__list-head-sub">
              {anyFilterActive ? (
                <>
                  <b>{fmtMoney(matchedUsd)}</b> a year
                </>
              ) : (
                <>
                  <b>{fmtMoney(totalUsd)}</b> a year
                </>
              )}
            </span>
          </div>

          {/* T7 R3 item 1: the column header row is gone. The row's
              two-column grid (name | price above 12 months) is
              self-labelling; vIngRow()/`.kf-row` has no colhead. */}

          {/* T7 item 4 / F16: the list is ONE tab stop. Up / Down /
              Home / End move the selection AND the detail follows;
              typing in the search does not steal the arrows because
              they are handled on the list, not the document. A skip
              link above the list lets Tab jump past it into the
              detail pane in reading order. */}
          <a
            href={selId ? `#detail-${selId}` : "#detail"}
            className="kf-ingp__list-skip"
            onClick={(e) => {
              e.preventDefault();
              const target = document.querySelector<HTMLElement>(".kf-ingp__dhead-acts button");
              target?.focus();
            }}
          >
            Skip to detail
          </a>
          <div className="kf-ingp__pane-scroll">
            {filtered.length === 0 ? (
              <div className="kf-ingp__list-empty">
                <div className="kf-ingp__list-empty-title">No ingredients match the current filters</div>
                <div className="kf-ingp__list-empty-body">Try clearing filters, or widen the category.</div>
                <button
                  type="button"
                  className="kf-btn kf-btn--line kf-btn--sm"
                  onClick={clearAll}
                >
                  Clear filters
                </button>
              </div>
            ) : (
              <ul
                className="kf-ingp__list"
                role="listbox"
                tabIndex={0}
                aria-label="Ingredients. Use the arrow keys."
                aria-activedescendant={selected ? `opt-${selected.id}` : undefined}
                onKeyDown={(e) => {
                  if (filtered.length === 0) return;
                  const idx = Math.max(0, filtered.findIndex((r) => r.id === selected?.id));
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    const nextRow = filtered[Math.min(filtered.length - 1, idx + 1)];
                    if (nextRow) selectRow(nextRow.id, "replace");
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    const prevRow = filtered[Math.max(0, idx - 1)];
                    if (prevRow) selectRow(prevRow.id, "replace");
                  } else if (e.key === "Home") {
                    e.preventDefault();
                    if (filtered[0]) selectRow(filtered[0].id, "replace");
                  } else if (e.key === "End") {
                    e.preventDefault();
                    const lastRow = filtered[filtered.length - 1];
                    if (lastRow) selectRow(lastRow.id, "replace");
                  } else if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    if (selected) openEditor();
                  }
                }}
              >
                {filtered.map((row) => (
                  <IngredientRow
                    key={row.id}
                    row={row}
                    selected={selected?.id === row.id}
                    match={matchField(row, trimmed)}
                    onSelect={() => selectRow(row.id)}
                    registerRef={(el) => {
                      if (el) rowRefs.current.set(row.id, el);
                      else rowRefs.current.delete(row.id);
                    }}
                  />
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* Detail pane. T7 ruling 5 + 8: the page has one scroll;
            the detail flows with the page (no `kf-ingp__pane-scroll`
            inner wrapper), and every editor lives in the drawer the
            Edit button opens. Below 1100 the layout stacks and the
            back link reads "All ingredients". */}
        <section
          id={selected ? `detail-${selected.id}` : "detail"}
          className="kf-ingp__pane kf-ingp__pane--detail"
          aria-label="Ingredient detail"
        >
          {selected && selectedIngredient ? (
            <>
              <button
                type="button"
                className="kf-ingp__dback"
                onClick={() => push({ open: null })}
              >
                ‹ All ingredients
              </button>
              <div className="kf-ingp__dflow" key={selected.id}>
                <DetailView
                  row={selected}
                  ingredient={selectedIngredient}
                  parentOptions={parentOptions}
                  onDone={() => {}}
                  onLoadParents={loadParents}
                  onOpenItem={(id) => openItemPanel(id)}
                  onOpenEditor={openEditor}
                  onSendBack={onSendBack}
                />
              </div>
            </>
          ) : null}
        </section>
      </div>

      {/* T7 ruling 8: the ingredient drawer. One component, three
          doors: Edit ingredient on this tab, the pencil on a review
          card, and the item panel's Open ingredient link. Keyed on
          the ingredient id so a step to another ingredient can
          never leak one's typed state into another (GOTCHAS 26). */}
      {urlEdit && selected && selectedIngredient ? (
        <DetailPanel
          key={selected.id}
          open={{ kind: "ingredient" }}
          onClose={closeEditor}
          ingredient={selectedIngredient}
          items={[]}
          parents={[]}
          parentOptions={parentOptions}
          onLoadParents={loadParents}
          onInvalidate={() => router.refresh()}
          onFocusReturn={() => {
            // Return focus to the Edit ingredient button that opened
            // the drawer, so the keyboard loop closes cleanly.
            document
              .querySelector<HTMLElement>("[data-ing-editor-btn]")
              ?.focus();
          }}
          // T7 R2 item 1: the drawer offers Send all back for a
          // linked ingredient; MasterSendAllBackButton inside
          // PanelClosedRows carries the ask + the batch post. The
          // review card's pencil leaves this prop unset.
          sendAllBack={
            selected.linkedItems.length > 0
              ? {
                  masterName: selected.name,
                  itemIds: selected.linkedItems.map((li) => li.id),
                }
              : undefined
          }
        />
      ) : null}

      {/* T6 item 8 + round 2 item 2: Prev/Next within the open
          ingredient's linked items; focus returns to the row's name
          button when the panel closes. T7 ruling 4: step writes the
          `drawer` key with replace; close drops it. */}
      {openItemId ? (
        <ItemPanelById
          itemId={openItemId}
          onClose={closeItemPanel}
          neighborIds={selected ? selected.linkedItems.map((li) => li.id) : null}
          onStep={stepItemPanel}
          onFocusReturn={(lastId) => {
            const el = document.querySelector<HTMLElement>(`[data-item-id="${lastId}"]`);
            if (el) {
              el.focus();
              return;
            }
            document.querySelector<HTMLElement>(".kf-ingp__item-name")?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

// -------------------------------------------------------------------
// List row
// -------------------------------------------------------------------

function IngredientRow({
  row,
  selected,
  match,
  onSelect,
  registerRef,
}: {
  row: MasterRow;
  selected: boolean;
  // T7 ruling 3 + item 5: when the search matched an item (not the
  // ingredient's own name), the row says which, as ingMatch() has
  // it ("Has item number 12345" / "Has item: Olive Oil, 3 L").
  match: MasterMatch;
  onSelect: () => void;
  registerRef: (el: HTMLButtonElement | null) => void;
}) {
  // T7 R3 item 1: the quiet spread sub-line is retired from the
  // row. The red "why" line covers the case that matters.
  void rowPriceSub;
  const badges = row.issues
    .map((k) => ({ kind: k, label: ISSUE_BADGE[k] }))
    .filter((b): b is { kind: MasterIssue; label: string } => !!b.label);

  const usdText = row.linkedCount > 0 ? fmtUsd(row.usd12m) : "-";

  // T7 item 5 / E: a row says why in full. The reason a row needs
  // attention has its own place and is never cut off. Pick the
  // first issue (the most actionable per the issue order the server
  // emits). Band + outlier read as "block" tone (red); everything
  // else is "warn" (amber).
  const topIssue = row.issues[0] ?? null;
  const whyText = topIssue ? issueLineFor(row, topIssue) : null;
  const moreCount = Math.max(0, row.issues.length - 1);
  const whyTone: "warn" | "block" | null =
    topIssue === "band" || topIssue === "outlier" ? "block" : topIssue ? "warn" : null;

  // T7 ruling 3 + item 5 / call 20: "A search hit says why." If the
  // search matched an item or a vendor (not the ingredient's own
  // name / parent / category), tell the person which, and the item
  // number when available.
  const searchHitText =
    match.kind === "hit" && match.field === "itemNumber" && match.item?.itemNumber
      ? `Has item number ${match.item.itemNumber}`
      : match.kind === "hit" && match.field === "item" && match.item
        ? `Has item: ${match.item.name}`
        : match.kind === "hit" && match.field === "vendor" && match.item
          ? `Has vendor ${match.item.vendor}`
          : null;

  return (
    <li
      className={`kf-ingp__row${row.issues.length > 0 ? " kf-ingp__row--att" : ""}${selected ? " kf-ingp__row--sel" : ""}`}
      role="option"
      id={`opt-${row.id}`}
      aria-selected={selected}
    >
      <button
        ref={registerRef}
        type="button"
        className="kf-ingp__row-btn"
        // T7 item 4: the list is one tab stop. Rows are NOT focusable
        // on Tab; click + the parent's arrow handler do the work.
        tabIndex={-1}
        onClick={onSelect}
      >
        <div className="kf-ingp__row-name">
          <span className="kf-ingp__row-name-main">{row.name}</span>
          <span className="kf-ingp__row-sub">
            <span>
              {row.parent ?? (row.category ? row.category : "No category")}
              {row.linkedCount > 0
                ? ` · ${fmtCount(row.linkedCount)} item${row.linkedCount === 1 ? "" : "s"}`
                : ""}
            </span>
            {row.resale ? <span className="kf-ingp__row-retail">Retail</span> : null}
            {badges.map((b) => (
              <span key={b.kind} className="kf-ingp__row-badge">{b.label}</span>
            ))}
          </span>
        </div>
        <div className="kf-ingp__row-price">
          {/* T7 R3 item 1: price on its own line. The old
              row-price-sub (the quiet spread like "2.3x spread") is
              removed from the markup; the attention line (row-why)
              carries the red one via rankedIssues. */}
          {row.avgPerBase != null ? (
            <>
              <b>{fmtUsd(row.avgPerBase)}</b> / {uomOrUnit(row.baseUom)}
            </>
          ) : (
            <>- / {(row.baseUnit || "unit").toLowerCase()}</>
          )}
        </div>
        <div className="kf-ingp__row-usd" aria-label={`12-month spend ${usdText}`}>
          {usdText}
        </div>
        {/* T7 item 5: full-width "why" cell. Never cut off; ellipsis
            is banned here. Search hits are on a line of their own
            when present and win over the attention line. */}
        {searchHitText ? (
          <span className="kf-ingp__row-why kf-ingp__row-why--hit">
            {searchHitText}
          </span>
        ) : whyText ? (
          <span className={`kf-ingp__row-why${whyTone === "block" ? " kf-ingp__row-why--block" : ""}`}>
            {whyText}
            {moreCount > 0 ? `, and ${moreCount} more` : ""}
          </span>
        ) : null}
      </button>
    </li>
  );
}

// T7 item 5 + reference issueLine(). Readable copy per issue kind,
// so the row and the attention block tell the same story.
function issueLineFor(row: MasterRow, k: MasterIssue): string {
  const u = uomOrUnit(row.baseUom);
  const n = row.linkedItems.filter((li) => li.statusKind === k as unknown as string).length;
  if (k === "band") return `The price looks wrong for ${u}`;
  if (k === "needs_measure") {
    const c = row.linkedItems.filter((li) => li.statusKind === "needs_measure").length;
    return `${fmtCount(Math.max(c, 1))} item${c === 1 ? " needs" : "s need"} a measure`;
  }
  if (k === "sizes_differ") return "The items are different sizes";
  if (k === "outlier") {
    const c = row.linkedItems.filter((li) => li.outlier).length;
    return `${fmtCount(Math.max(c, 1))} item${c === 1 ? " is" : "s are"} priced far from the rest`;
  }
  if (k === "coverage") {
    const un = Math.max(1, row.linkedCount - row.pricedCount);
    return `${fmtCount(un)} of ${fmtCount(row.linkedCount)} item${row.linkedCount === 1 ? " has" : "s have"} no price`;
  }
  if (k === "spread") return `Prices are ${(row.spreadRatio ?? 0).toFixed(1)}x apart`;
  if (k === "empty") return "No linked items";
  void n;
  return String(k);
}

// -------------------------------------------------------------------
// Detail view (head + strip + attention + zone + linked + closed)
// -------------------------------------------------------------------

function DetailView({
  row,
  ingredient: _ingredient,
  parentOptions: _parentOptions,
  onDone: _onDone,
  onLoadParents: _onLoadParents,
  onOpenItem,
  onOpenEditor,
  onSendBack,
}: {
  row: MasterRow;
  ingredient: ReviewCardIngredient;
  // T7 ruling 8: the detail no longer mounts the editor zone, so the
  // parentOptions / onDone / onLoadParents props that the in-page
  // mount used are now unused here. The drawer (DetailPanel in
  // ingredient mode) takes them from the same source.
  parentOptions: string[];
  onDone: () => void;
  onLoadParents: () => Promise<ReviewCardIngredient[]>;
  onOpenItem: (id: string) => void;
  onOpenEditor: () => void;
  // T7 R2 item 2: Send back returns its outcome so the row can
  // decide what to show (a toast with Undo on success; an inline
  // sentence on failure).
  onSendBack: (
    itemId: string,
    itemName: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  // N12 §2c.1: vendor count = distinct vendor names in linkedItems.
  const vendorCount = useMemo(() => {
    const set = new Set<string>();
    for (const li of row.linkedItems) if (li.vendor) set.add(li.vendor);
    return set.size;
  }, [row.linkedItems]);

  // T7 ruling 4: lens + unit live in the URL as replace keys so a
  // reload / shared link lands on the same view. Lens / unit the
  // current ingredient does not have falls back to its default.
  const detailParams = useSearchParams();
  const detailRouter = useRouter();
  function pushDetail(patch: Record<string, string | null>) {
    const next = new URLSearchParams(detailParams.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === "") next.delete(k);
      else next.set(k, v);
    }
    const qs = next.toString();
    detailRouter.replace(qs ? `?${qs}` : "?");
  }
  const populatedLenses = (["standard", "premium"] as const).filter(
    (k) => row.statsByLens[k].linkedCount > 0
  );
  const showLens = populatedLenses.length >= 2;
  const urlLens = detailParams.get("lens");
  const lens: "blended" | "standard" | "premium" =
    urlLens === "standard" || urlLens === "premium" ? urlLens : "blended";
  const effectiveLens: "blended" | "standard" | "premium" = showLens ? lens : "blended";
  const active = row.statsByLens[effectiveLens];

  // M2 §4B part 3 fix 9 + polish fix 3: chip view switch. Chips are
  // the five intent units (lb, oz, each, fl oz, gal) in that order;
  // only those reachable from the ingredient's base unit (built-in
  // same-dim + measures-bridged) render. T7 ruling 4: viewUom lives
  // in the URL as `unit`. A unit the selected ingredient does not
  // reach falls back to its base_unit canonical form.
  const baseCanonical = canonicalFromBaseUnit(row.baseUnit);
  const reachList = useMemo<string[]>(() => {
    if (!baseCanonical) return [];
    const set = reachableUnits([baseCanonical], { measures: row.measures as Measure[] });
    const order: readonly string[] = ["LB", "OZ", "EA", "FLOZ", "GAL"];
    return order.filter((u) => set.has(u));
  }, [baseCanonical, row.measures]);
  const urlUnit = detailParams.get("unit");
  const viewUom =
    urlUnit && reachList.includes(urlUnit) ? urlUnit : (baseCanonical ?? "LB");

  const uom = viewUom && viewUom !== baseCanonical ? uomLabel(viewUom) : uomOrUnit(row.baseUom);

  // M2 §4B part 3 fix 9: reprice each linked item in viewUom. Skip
  // items that don't yet reach the viewUom (statusKind stays what the
  // server said; price displays as "-" with the view's unit).
  const repricedLinkedItems = useMemo(() => {
    return row.linkedItems.map((li) => {
      if (li.perBase == null || li.perBaseUom == null) {
        return { ...li, viewPrice: null as number | null };
      }
      if (baseCanonical && viewUom === baseCanonical) {
        // Same as row baseline - keep the server perBase when it is
        // already in-ingredient-unit; otherwise null.
        return {
          ...li,
          viewPrice: li.perBaseUom === row.baseUom ? li.perBase : null,
        };
      }
      const result = priceInUnit(
        {
          perBase: li.perBase,
          baseUom: li.perBaseUom,
          packQty: li.packQty ?? null,
          packSize: li.packSize ?? null,
          packUom: li.packUom ?? null,
          caseWeightLb: li.caseWeightLb ?? null,
        },
        viewUom,
        { measures: row.measures as Measure[] },
      );
      return { ...li, viewPrice: result?.per ?? null };
    });
  }, [row.linkedItems, row.baseUom, row.measures, viewUom, baseCanonical]);

  // T1 fix 2: the unit chip must never change which items are in the
  // number. In any lens, the price and the low / high shown in unit X
  // are the LENS's own price and low / high converted to X - one
  // definition of the mean, in blend.ts (via `active.avgPerBase`).
  //
  // factor(from, to, m) returns "how many `to` units in 1 `from`
  // unit", so a price in /from becomes /to by DIVIDING by that
  // factor. Example: base LB, view OZ, factor(LB, OZ) = 16; a per-lb
  // lens price divided by 16 is the per-oz view price.
  const viewConvFactor: number | null = useMemo(() => {
    if (!baseCanonical) return null;
    if (viewUom === baseCanonical) return 1;
    return factor(baseCanonical, viewUom, { measures: row.measures as Measure[] });
  }, [baseCanonical, viewUom, row.measures]);
  const stripPrice: number | null = useMemo(() => {
    if (viewConvFactor == null || viewConvFactor <= 0) return null;
    return active.avgPerBase != null ? active.avgPerBase / viewConvFactor : null;
  }, [active.avgPerBase, viewConvFactor]);

  const stripMinMax: { min: number; max: number } | null = useMemo(() => {
    if (viewConvFactor == null || viewConvFactor <= 0) return null;
    if (active.minPerBase == null || active.maxPerBase == null) return null;
    return {
      min: active.minPerBase / viewConvFactor,
      max: active.maxPerBase / viewConvFactor,
    };
  }, [active.minPerBase, active.maxPerBase, viewConvFactor]);

  const partial = active.linkedCount > 0 && active.pricedCount < active.linkedCount;
  // T6 §2: red only when the figure IN THE TILE describes a real
  // in-grade defect. On a two-grade master with Blended selected the
  // tile paints the across-grade ratio, which the G3 rule says is
  // the grade working, not a pricing problem - house rule is red
  // means one thing. Single-grade masters are unchanged: blended
  // is the subset. Standard / Premium selected: the subset's own
  // ratio decides (what active.spreadRatio already is).
  const bothGradesPopulated =
    row.statsByLens.standard.linkedCount > 0 &&
    row.statsByLens.premium.linkedCount > 0;
  const spreadBad =
    effectiveLens === "blended" && bothGradesPopulated
      ? false
      : active.spreadRatio != null && active.spreadRatio > SPREAD_RATIO_MAX;

  const derivedForStrip = stripDerivedSub(row, active);

  return (
    <>
      {/* Head - T7 ruling 8 (three doors, one drawer) + item 1: the
          page is for reading. The eyebrow / name / one line of
          facts live here; the Edit ingredient button opens the
          drawer (one component, three doors - the pencil on a
          review card and Open ingredient in the item panel are
          the other two). */}
      <div className="kf-ingp__dhead">
        <div className="kf-ingp__dhead-body">
          <span className={`kf-ingp__dhead-eyebrow${(!row.category || !row.parent) ? " kf-ingp__dhead-eyebrow--warn" : ""}`}>
            {row.category || "Needs category"}
            {row.parent ? ` · ${row.parent}` : ""}
            {row.resale ? " · Retail" : ""}
          </span>
          <h2>{row.name}</h2>
          <div className="kf-ingp__dhead-meta">
            {/* T7 item 1: one summary line of the ingredient's own
                facts, as vIngDetail() has it. Costed per / Priced
                per (retail), yield (recipe only), allergens and
                Recipes can use. Allergens read as words only; the
                drawer edits them (ruling 1). */}
            <span>
              {row.resale ? "Priced per" : "Costed per"} <b>{uomOrUnit(row.baseUom)}</b>
            </span>
            {row.resale ? null : (
              <span>
                Yield <b>{row.yieldPct != null ? `${row.yieldPct}%` : "not set"}</b>
              </span>
            )}
            <span>
              Allergens <b>{allergenWords(row)}</b>
            </span>
            {row.resale ? null : (
              <span>
                Recipes can use <b>{reachWords(row)}</b>
              </span>
            )}
          </div>
        </div>
        <div className="kf-ingp__dhead-acts">
          <button
            type="button"
            className="kf-btn kf-btn--line kf-btn--sm"
            onClick={onOpenEditor}
            data-ing-editor-btn
          >
            Edit ingredient
          </button>
        </div>
      </div>

      {/* M2 §4B part 3 fix 9: chip view switch. Picks which unit
          every row in the expand is priced in. Browser-only reprice
          via priceInUnit; status (in blend / needs measure / etc.)
          is unchanged. Resets when the expand remounts (per row.id). */}
      {reachList.length > 1 ? (
        <div className="kf-ingp__dzone-chips" aria-label="Show prices in">
          {reachList.map((u) => {
            const isActive = u === viewUom;
            return (
              <button
                key={u}
                type="button"
                className={`kf-chip${isActive ? " kf-chip--solid" : " kf-chip--line"}`}
                onClick={() => pushDetail({ unit: u === baseCanonical ? null : u })}
                aria-pressed={isActive}
              >
                {/* Polish fix 3: chip label is the plain unit ("lb"),
                    not "per lb" - the strip's "/ lb" already supplies
                    the preposition. */}
                {uomLabel(u)}
              </button>
            );
          })}
        </div>
      ) : null}

      {/* Strip - round 2 fix 9: value + unit on one line, no wrap;
          lens select below Price is the compact chrome, never
          clipped, with a 44 px click target. */}
      <div className="kf-ipanel__strip kf-ingp__dzone-strip">
        <div className="kf-ipanel__strip-cell">
          {/* T7 R3 item 3: label + lens on one in-flow row so the
              tile row sits at about 98 px instead of the old 154.
              The wrapper span is the grid cell's first child; its
              `margin-left: auto` on the lens pulls the menu to
              the right of the label's row without an absolute
              position (which overlapped the price in the earlier
              test). The item panel's kf-ipanel__strip is not
              touched (scoped through kf-ingp__dzone-strip only). */}
          <span className="kf-ingp__dzone-strip-head">
            <span className="kf-ipanel__strip-label">
              {effectiveLens === "blended" ? "Price" : effectiveLens === "standard" ? "Standard price" : "Premium price"}
            </span>
            {showLens ? (
              <label className="kf-ingp__lens">
                <select
                  value={effectiveLens}
                  onChange={(e) => {
                    const v = e.target.value as "blended" | "standard" | "premium";
                    pushDetail({ lens: v === "blended" ? null : v });
                  }}
                  aria-label="Price lens"
                >
                  <option value="blended">Blended</option>
                  <option value="standard">Standard</option>
                  <option value="premium">Premium</option>
                </select>
              </label>
            ) : null}
          </span>
          <span className="kf-ipanel__strip-value kf-ipanel__strip-value--accent">
            {stripPrice != null ? fmtUsd(stripPrice) : "-"}{" "}
            <span className="kf-ipanel__strip-value-unit">/ {uom}</span>
          </span>
          <span className="kf-ipanel__strip-sub">
            {active.pricedCount > 0
              ? `${fmtCount(active.pricedCount)} priced`
              : "no priced items"}
            {derivedForStrip ? ` · ${derivedForStrip}` : ""}
          </span>
        </div>
        <div className="kf-ipanel__strip-cell">
          <span className="kf-ipanel__strip-label">Spread</span>
          <span className={`kf-ipanel__strip-value${spreadBad ? "" : " kf-ipanel__strip-value--accent"}`}
                style={spreadBad ? { color: "var(--sp-block)" } : undefined}>
            {active.spreadRatio != null ? `${active.spreadRatio.toFixed(1)}x` : "-"}
          </span>
          <span className="kf-ipanel__strip-sub">
            {stripMinMax
              ? `${fmtUsd(stripMinMax.min)} to ${fmtUsd(stripMinMax.max)}`
              : active.pricedCount < 2
                ? "needs 2 priced items"
                : "-"}
          </span>
        </div>
        <div className="kf-ipanel__strip-cell">
          <span className="kf-ipanel__strip-label">Priced</span>
          <span className={`kf-ipanel__strip-value${partial ? "" : " kf-ipanel__strip-value--accent"}`}
                style={partial ? { color: "var(--sp-warn)" } : undefined}>
            {fmtCount(active.pricedCount)}{" "}
            <span className="kf-ipanel__strip-value-unit">of {fmtCount(active.linkedCount)}</span>
          </span>
          <span className="kf-ipanel__strip-sub">
            {active.linkedCount === 0
              ? "no linked items"
              : partial
                ? `${fmtCount(active.linkedCount - active.pricedCount)} item${active.linkedCount - active.pricedCount === 1 ? "" : "s"} unpriced`
                : "all items priced"}
          </span>
        </div>
        <div className="kf-ipanel__strip-cell">
          <span className="kf-ipanel__strip-label">12-mo spend</span>
          <span className="kf-ipanel__strip-value kf-ipanel__strip-value--accent">
            {row.linkedCount > 0 ? fmtMoney(active.usd12m) : "-"}
          </span>
          <span className="kf-ipanel__strip-sub">
            {row.linkedCount > 0
              ? `${fmtCount(row.linkedCount)} linked item${row.linkedCount === 1 ? "" : "s"}`
              : "no linked items"}
          </span>
        </div>
      </div>

      {/* Attention */}
      <div className="kf-ingp__dzone--attn-wrap">
        <IngredientAttention row={row} onDone={_onDone} />
      </div>

      {/* T7 ruling 8: the Ingredient zone (Name / Category / Costed
          per / Measures / Yield / Recipes can use / Allergens) and
          the four folds (Retail / Merge / Send all back / Change
          history) lived in the page until train 6. They moved
          entirely into the ingredient drawer; a click on Edit
          ingredient above opens it. Nothing editable is drawn here
          any more. The page is for reading; the drawer is for
          editing. */}

      {/* Linked items - T7 item 6: the only table, LINKED_HEAD's
          order: Item / Pack / Price / 12 months / Last bought /
          Send back. Grade is a word in the row sub-line (ruling 6);
          Send back acts at once with Undo (ruling 2). The table is
          not inside a second scroller; it flows with the page
          (ruling 5). */}
      <div className="kf-ingp__dzone kf-ingp__dzone--section">
        <div className="kf-ingp__dzone--section-head">
          <h3>Linked items · {fmtCount(row.linkedCount)}</h3>
          <span className="kf-ingp__dzone-sub">Click an item to open it</span>
        </div>
        {row.linkedItems.length === 0 ? (
          <div className="kf-ingp__list-empty">
            <div className="kf-ingp__list-empty-title">No vendor items</div>
            <div className="kf-ingp__list-empty-body">
              No live items are linked to this ingredient. If it is a fresh split, the matcher will
              attach items next run; otherwise it is likely ready to retire.
            </div>
          </div>
        ) : (
          <LinkedItems
            row={row}
            onOpenItem={onOpenItem}
            viewUom={viewUom}
            viewUnitLabel={uom}
            repricedItems={repricedLinkedItems}
            onSendBack={onSendBack}
          />
        )}
      </div>
    </>
  );
}

// -------------------------------------------------------------------
// Attention block - IssueNote sentences, item-panel attn primitive
// -------------------------------------------------------------------

function IngredientAttention({ row, onDone }: { row: MasterRow; onDone: () => void }) {
  const uom = uomOrUnit(row.baseUom);
  type Issue = { lead: string; body: ReactNode };
  const issues: Issue[] = [];

  // N12 round 2 fix 13: zero-linked ingredients cannot be "flagged"
  // or "clean" against nothing. Say the no-items sentence, warn tone.
  if (row.linkedCount === 0) {
    return (
      <div className="kf-ipanel__attn" aria-label="What needs attention">
        <div className="kf-ipanel__attn-item">
          <span className="kf-ipanel__attn-icon">
            <AlertTriangle size={22} strokeWidth={1.75} aria-hidden />
          </span>
          <div className="kf-ipanel__attn-item-text">
            <span className="kf-ipanel__attn-item-head">No live vendor items</span>
            <span className="kf-ipanel__attn-item-body">
              No live items are linked to this ingredient. If it is a fresh split, the matcher
              will attach items next run; otherwise it is likely ready to retire.
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (row.issues.includes("spread")) {
    // T5: the G3 flag rule fires on a populated grade subset whose
    // own spreadRatio > SPREAD_RATIO_MAX, not on the blended figure. The banner was
    // reading row.spreadRatio / row.minPerBase / row.maxPerBase, which
    // are the BLENDED numbers; for a two-bucket ingredient (Standard
    // over threshold, Premium under) that printed the Standard-floor-
    // vs-Premium-ceiling gap, a number that describes no in-grade
    // item pair. The row already carries statsByLens.standard /
    // .premium - we just read the right three fields off the right
    // object.
    //
    // Single-grade ingredients (the common case: 2032 / 2076 items
    // carry no grade, zero items are tagged standard) render the
    // original copy byte-identical: that subset IS the blend. No
    // grade word.
    const std = row.statsByLens.standard;
    const prem = row.statsByLens.premium;
    const stdPopulated = std.linkedCount > 0;
    const premPopulated = prem.linkedCount > 0;
    const bothPopulated = stdPopulated && premPopulated;
    const stdOver = stdPopulated && std.spreadRatio != null && std.spreadRatio > SPREAD_RATIO_MAX;
    const premOver = premPopulated && prem.spreadRatio != null && prem.spreadRatio > SPREAD_RATIO_MAX;
    if (!bothPopulated) {
      issues.push({
        lead: `Spread is ${row.spreadRatio?.toFixed(1)}x.`,
        body: (
          <>
            {" "}Cheapest linked item is {fmtUsd(row.minPerBase ?? 0)}/{uom}, dearest is{" "}
            {fmtUsd(row.maxPerBase ?? 0)}/{uom}. Over 3x usually means one item has a bad pack size,
            not a real price difference.
          </>
        ),
      });
    } else if (stdOver && premOver) {
      issues.push({
        lead: `Standard spread is ${std.spreadRatio!.toFixed(1)}x; Premium spread is ${prem.spreadRatio!.toFixed(1)}x.`,
        body: (
          <>
            {" "}Standard items run {fmtUsd(std.minPerBase ?? 0)} to {fmtUsd(std.maxPerBase ?? 0)} / {uom};
            Premium items run {fmtUsd(prem.minPerBase ?? 0)} to {fmtUsd(prem.maxPerBase ?? 0)} / {uom}.
            Over 3x inside one grade usually means one item has a bad pack size, not a real price difference.
          </>
        ),
      });
    } else if (stdOver) {
      issues.push({
        lead: `Standard spread is ${std.spreadRatio!.toFixed(1)}x.`,
        body: (
          <>
            {" "}Cheapest Standard item is {fmtUsd(std.minPerBase ?? 0)} / {uom}, dearest is{" "}
            {fmtUsd(std.maxPerBase ?? 0)} / {uom}. Over 3x inside one grade usually means one item
            has a bad pack size, not a real price difference.
          </>
        ),
      });
    } else if (premOver) {
      issues.push({
        lead: `Premium spread is ${prem.spreadRatio!.toFixed(1)}x.`,
        body: (
          <>
            {" "}Cheapest Premium item is {fmtUsd(prem.minPerBase ?? 0)} / {uom}, dearest is{" "}
            {fmtUsd(prem.maxPerBase ?? 0)} / {uom}. Over 3x inside one grade usually means one item
            has a bad pack size, not a real price difference.
          </>
        ),
      });
    } else {
      // Defensive: both subsets populated but neither over threshold.
      // The G3 flag rule should not fire here, but fall back to the
      // original copy if it somehow does.
      issues.push({
        lead: `Spread is ${row.spreadRatio?.toFixed(1)}x.`,
        body: (
          <>
            {" "}Cheapest linked item is {fmtUsd(row.minPerBase ?? 0)}/{uom}, dearest is{" "}
            {fmtUsd(row.maxPerBase ?? 0)}/{uom}. Over 3x usually means one item has a bad pack size,
            not a real price difference.
          </>
        ),
      });
    }
  }
  if (row.issues.includes("coverage")) {
    issues.push({
      lead: `${fmtCount(row.linkedCount - row.pricedCount)} of ${fmtCount(row.linkedCount)} linked items are not in this price.`,
      body: (
        <>
          {" "}
          <strong>{fmtUsd(row.unpricedUsd)}</strong> of this ingredient&rsquo;s{" "}
          {fmtUsd(row.usd12m)} sits outside the blend - either no per-unit price at all, or a
          price in a different unit. The figure above describes {fmtCount(row.pricedCount)} item
          {row.pricedCount === 1 ? "" : "s"}, not {fmtCount(row.linkedCount)}.
        </>
      ),
    });
  }
  if (row.issues.includes("sizes_differ")) {
    // M2.1 fix 2: sizes_differ had no explanation block. The lead
    // counts the items the pipeline tagged; the body mirrors the
    // detail panel's attention banner so both surfaces say the same
    // sentence.
    const n = row.linkedItems.filter((li) => li.statusKind === "sizes_differ").length;
    issues.push({
      lead: `${fmtCount(n)} case${n === 1 ? "" : "s"} come in different sizes.`,
      body: (
        <>
          {" "}This ingredient is costed per <strong>{uom}</strong>, but its cases hold different
          piece sizes within one kind. Say what one each is, or cost this ingredient by weight or
          volume - whichever kind the cases are in.
        </>
      ),
    });
  }
  if (row.issues.includes("needs_measure")) {
    const n = row.linkedItems.filter((li) => li.statusKind === "needs_measure").length;
    // N12 round 2 fix 15: suggested base-unit printed through uomLabel
    // so "floz" reads "fl oz", not the raw column form.
    const suggested = row.suggestedBaseUnit
      ? uomLabel(row.suggestedBaseUnit) || BASE_UNIT_WORD[row.suggestedBaseUnit] || row.suggestedBaseUnit
      : null;
    issues.push({
      lead: `${fmtCount(n)} item${n === 1 ? "" : "s"} priced in a different unit.`,
      body: (
        <>
          {" "}This ingredient is costed per <strong>{uom}</strong>, but{" "}
          {n === 1 ? "an item is" : "those items are"} priced per a different dimension. Those
          numbers are not comparable and never reach the blend until the unit is fixed.
          {suggested ? (
            <>
              {" "}Most of its priced items are in <strong>{suggested}</strong>, so the ingredient
              is probably the one set wrong - it was created on the default.{" "}
              <SuggestBaseUnitLink row={row} suggestedLabel={suggested} onDone={onDone} />
            </>
          ) : null}
        </>
      ),
    });
  }
  if (row.issues.includes("outlier")) {
    const o = row.linkedItems.filter((li) => li.outlier);
    const median = row.medianBeforeExclusion;
    issues.push({
      lead: `${fmtCount(o.length)} item${o.length === 1 ? "" : "s"} excluded as outlier${o.length === 1 ? "" : "s"}.`,
      body: (
        <>
          {" "}
          {o
            .map(
              (li) =>
                `${li.name} at ${fmtUsd(li.perBase ?? 0)}/${uomLabel(li.perBaseUom)}${li.priceManualOverride ? " (set by hand)" : ""}`
            )
            .join("; ")}
          {median != null ? ` against a ${fmtUsd(median)}/${uom} median.` : "."}{" "}
          Excluded from the ingredient&rsquo;s blend; survivors give{" "}
          {row.avgPerBase != null ? `${fmtUsd(row.avgPerBase)}/${uom}` : "no blend"}.
        </>
      ),
    });
  }
  if (row.issues.includes("band")) {
    issues.push({
      lead: "Average is outside the typical band for this unit.",
      body: <> A soft signal, not an assertion - worth a look at the pack sizes.</>,
    });
  }

  if (issues.length === 0) {
    return (
      <div className="kf-ipanel__attn" aria-label="What needs attention">
        <div className="kf-ipanel__attn-item kf-ipanel__attn-item--good">
          <span className="kf-ipanel__attn-icon">
            <Check size={22} strokeWidth={1.75} aria-hidden />
          </span>
          <div className="kf-ipanel__attn-item-text">
            <span className="kf-ipanel__attn-item-head">Nothing flagged</span>
            <span className="kf-ipanel__attn-item-body">
              All {fmtCount(row.linkedCount)} linked items carry a price, in one unit, inside the
              expected band.
            </span>
          </div>
        </div>
      </div>
    );
  }

  // N12 round 2 fix 7: one box with a summary head + <ul> of
  // per-issue lines (frames B / C). Tone = the strongest tone across
  // the issues.
  const toneRank = (k: MasterIssue): number =>
    k === "spread" || k === "outlier" ? 3 : k === "needs_measure" ? 2 : 1;
  const strongestKind = [...row.issues].sort((a, b) => toneRank(b) - toneRank(a))[0];
  const tone =
    strongestKind === "spread" || strongestKind === "outlier" ? "bad" : strongestKind === "needs_measure" ? "info" : "warn";

  return (
    <div className="kf-ipanel__attn" aria-label="What needs attention">
      <div className={`kf-ipanel__attn-item${tone === "bad" ? " kf-ipanel__attn-item--bad" : tone === "info" ? " kf-ipanel__attn-item--info" : ""}`}>
        <span className="kf-ipanel__attn-icon">
          <AlertTriangle size={22} strokeWidth={1.75} aria-hidden />
        </span>
        <div className="kf-ipanel__attn-item-text">
          <span className="kf-ipanel__attn-item-head">
            {issues.length} thing{issues.length === 1 ? "" : "s"} need{issues.length === 1 ? "s" : ""} attention
          </span>
          <ul className="kf-ingp__attn-list">
            {issues.map((n) => (
              <li key={n.lead}>
                <b>{n.lead}</b>{n.body}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function SuggestBaseUnitLink({
  row,
  suggestedLabel,
  onDone,
}: {
  row: MasterRow;
  suggestedLabel: string;
  onDone: () => void;
}) {
  // T2 §1 + ruling 3: route through the shared save path (dropped
  // connection caught, one wording vocabulary) and carry the same
  // 10 s Undo the menu writer carries so this button is the menu's
  // equal, not a shortcut with fewer undos.
  const router = useRouter();
  const { save: runSave, busy, error } = useSaveWithRefresh();
  const next = row.suggestedBaseUnit;
  if (!next) return null;

  async function apply() {
    if (busy || !next) return;
    const prev = row.baseUnit;
    const id = row.id;
    const label = suggestedLabel;
    await runSave({
      op: () =>
        postJson("/api/review/set-base-unit", {
          ingredientId: id,
          baseUnit: next,
        }),
      successMessage: `Switched to ${label}`,
      onDone,
      fireSuccessToast: (_d, message) => {
        toast(message, {
          undo: async () => {
            const u = await postJson("/api/review/set-base-unit", {
              ingredientId: id,
              baseUnit: prev,
            });
            if (!u.ok) throw new Error(saveErrorSentence(u) ?? "Nothing was saved.");
            // T2 round 2 §2: refresh the page so the row (its
            // Costed-per label + every price that reads base_unit)
            // shows the previous unit without a reload.
            router.refresh();
            onDone();
          },
        });
      },
    });
  }

  return (
    <>
      <button
        type="button"
        className="kf-ingp__attn-fix"
        onClick={apply}
        disabled={busy}
      >
        {busy ? "Switching..." : `Cost this per ${suggestedLabel} instead`}
      </button>
      {error ? (
        <span className="kf-dpn__flash kf-dpn__flash--err" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}

// -------------------------------------------------------------------
// Linked-items table
// -------------------------------------------------------------------

function LinkedItems({
  row,
  onOpenItem,
  viewUom,
  viewUnitLabel,
  repricedItems,
  onSendBack,
}: {
  row: MasterRow;
  onOpenItem: (id: string) => void;
  viewUom: string;
  viewUnitLabel: string;
  repricedItems: Array<MasterLinkedItem & { viewPrice: number | null }>;
  onSendBack: (
    itemId: string,
    itemName: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  // N12 §R1 echo: lowest / highest tag among items IN THE BLEND
  // (priced in the ingredient's dimension through M2's priceInUnit).
  // Need 2+; ties tag the first; no tag when min === max. Tags run
  // off the repriced view, not the server baseline.
  const tagMap = useMemo(() => {
    const m = new Map<string, "lowest" | "highest">();
    const inBlend = repricedItems.filter(
      (li) => li.statusKind === "in_blend" && li.viewPrice != null
    );
    if (inBlend.length < 2) return m;
    const sorted = [...inBlend].sort(
      (a, b) => (a.viewPrice ?? 0) - (b.viewPrice ?? 0)
    );
    const min = sorted[0].viewPrice;
    const max = sorted[sorted.length - 1].viewPrice;
    if (min === max) return m;
    m.set(sorted[0].id, "lowest");
    m.set(sorted[sorted.length - 1].id, "highest");
    return m;
  }, [repricedItems]);

  const base = uomOrUnit(row.baseUom);

  return (
    <table className="kf-ingp__items">
      {/* T7 item 6 / LINKED_COLS: Item flexes; Pack, Price, 12
          months, Last bought get fixed widths; action is a narrow
          column with an sr-only label. */}
      <colgroup>
        <col />
        <col style={{ width: "19%" }} />
        <col style={{ width: "15%" }} />
        <col style={{ width: "12%" }} />
        <col style={{ width: "13%" }} />
        <col style={{ width: "96px" }} />
      </colgroup>
      <thead>
        <tr>
          <th>Item</th>
          <th>Pack</th>
          <th className="kf-ingp__items-num">Price</th>
          <th className="kf-ingp__items-num">12 months</th>
          <th>Last bought</th>
          <th><span className="kf-sr">Send back</span></th>
        </tr>
      </thead>
      <tbody>
        {repricedItems.map((li) => {
          const tag = tagMap.get(li.id);
          return (
            <tr key={li.id}>
              <td>
                <button
                  type="button"
                  className="kf-ingp__item-name"
                  data-item-id={li.id}
                  onClick={() => onOpenItem(li.id)}
                >
                  {li.name}
                </button>
                <span className="kf-ingp__item-sub">
                  {li.vendor}
                  {li.itemNumber ? ` · item number ${li.itemNumber}` : " · no item number"}
                  {/* T7 R2 item 6: "catch weight" lives on the Pack
                      cell (the fact the price actually uses) and
                      is not repeated here. */}
                  {/* T7 ruling 6: Grade is a word in the sub-line,
                      only when non-standard. */}
                  {li.grade === "premium" ? (
                    <>
                      {" · "}
                      <span className="kf-word--premium">Premium</span>
                    </>
                  ) : null}
                  {/* T3 §4: every row left out of the blend names why
                      on the same sub-line, in the same style. */}
                  {li.statusKind === "sizes_differ" ? (
                    <>
                      {" · "}
                      <span className="kf-ingp__item-sub-warn">
                        left out - pack sizes differ
                      </span>
                    </>
                  ) : null}
                  {li.statusKind === "needs_measure" ? (
                    <>
                      {" · "}
                      <span className="kf-ingp__item-sub-warn">
                        priced per {uomLabel(li.perBaseUom) || "?"}, not per {base}
                      </span>
                    </>
                  ) : null}
                  {li.outlier ? (
                    <>
                      {" · "}
                      <span className="kf-ingp__item-sub-warn">
                        outlier, left out of the blend
                        {li.priceManualOverride ? " · set by hand" : ""}
                      </span>
                    </>
                  ) : null}
                </span>
              </td>
              <td>
                {/* T7 R2 item 6: show the pack the PRICE uses, not
                    the pack as written. packInUseText reads
                    packQty / packSize / packUom first (those are
                    the columns a hand-set pack_override writes to),
                    then falls back to the raw packText, then to
                    "Pack not read". Same precedence the item
                    panel's Pack fact applies via itemFacts.pack. */}
                {(() => {
                  const p = packInUseText({
                    packQty: li.packQty,
                    packSize: li.packSize,
                    packUom: li.packUom,
                    packText: li.packText,
                    catchWeight: li.catchWeight,
                  });
                  if (!p.known) return <span className="kf-muted">{p.text}</span>;
                  return (
                    <>
                      {fmtPackNumbersInText(p.text)}
                      {p.catchWeight ? (
                        <span className="kf-ingp__item-sub"> catch weight</span>
                      ) : null}
                    </>
                  );
                })()}
              </td>
              <td className="kf-ingp__items-num">
                <div className="kf-ingp__items-price">
                  <span>
                    {li.viewPrice != null ? (
                      <>
                        <b>{fmtUsd(li.viewPrice)}</b> / {viewUnitLabel}
                      </>
                    ) : (
                      <b>- / {viewUnitLabel}</b>
                    )}
                  </span>
                  {tag ? <span className="kf-ipanel__tag">{tag}</span> : null}
                </div>
              </td>
              <td className="kf-ingp__items-num">
                <b>{fmtUsdLong(li.usd12m)}</b>
              </td>
              <td>
                {/* T7 item 5 / E: "A blank is never shown as a
                    fact." No last_seen reads "never" in words. */}
                {li.lastSeen ? fmtLastBought(li.lastSeen) : <span className="kf-muted">never</span>}
              </td>
              <td className="kf-ingp__items-num">
                <SendBackCell
                  itemId={li.id}
                  itemName={li.name}
                  onSendBack={onSendBack}
                  repricedItems={repricedItems}
                />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// T7 R2 item 2: Send back is one row-cell with its own busy +
// error state. The button is off while the POST is out; a failed
// Send back says so beside the button (train 2's three sentences;
// no toast - PR78 says a failure with a place in the page fires
// no toast). On success, focus moves to the next row's item name,
// or to the linked-items heading when the row that just left was
// the last one in the table.
function SendBackCell({
  itemId,
  itemName,
  onSendBack,
  repricedItems,
}: {
  itemId: string;
  itemName: string;
  onSendBack: (
    itemId: string,
    itemName: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  repricedItems: Array<MasterLinkedItem & { viewPrice: number | null }>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doSend() {
    if (busy) return;
    setBusy(true);
    setError(null);
    // Pick the focus target BEFORE the row disappears. The next
    // row's item name, else the previous row's, else the table's
    // heading.
    const idx = repricedItems.findIndex((li) => li.id === itemId);
    const next = repricedItems[idx + 1] ?? repricedItems[idx - 1] ?? null;
    const res = await onSendBack(itemId, itemName);
    if (!res.ok) {
      setError(res.error);
      setBusy(false);
      return;
    }
    // Success: the parent's router.refresh will take this row out
    // of the DOM. Move focus on the next frame so the target still
    // exists; fall back to the section heading.
    requestAnimationFrame(() => {
      if (next) {
        const el = document.querySelector<HTMLElement>(
          `[data-item-id="${next.id}"]`,
        );
        if (el) { el.focus(); return; }
      }
      const head = document.querySelector<HTMLElement>(
        ".kf-ingp__dzone--section-head h3",
      );
      head?.focus();
    });
  }

  return (
    <>
      <button
        type="button"
        className="kf-rowlink"
        onClick={doSend}
        disabled={busy}
        aria-label={`Send ${itemName} back to the queue`}
      >
        {busy ? "Sending..." : "Send back"}
      </button>
      {error ? (
        <span className="kf-ingp__row-error" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}

// T7 item 6 / Last bought: a short "N days ago" / "Nov 2026" / etc
// phrasing. fmtDate from lib/fmt handles the ISO parse; we do not
// invent a vocabulary here. "today" vs "N days ago" vs "mon YYYY"
// stays consistent with the rest of the Ingredients screens.
function fmtLastBought(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  const ms = Date.now() - d.getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days < 1) return "today";
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  if (days < 30) {
    const w = Math.floor(days / 7);
    return `${w} week${w === 1 ? "" : "s"} ago`;
  }
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}
