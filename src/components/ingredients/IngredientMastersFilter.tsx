"use client";

// Client-side search / sort / filter over the already-loaded master
// list from IngredientMasters. Mirrors ReviewFilter's shape: sticky
// search + chip rail. Workbench shape: list on the left, persistent
// detail pane on the right (Prompt Q1), with each linked vendor item
// in the pane carrying an "Open" link to the vendor-items drawer so
// Kevin can jump to the bad one.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowDownAZ,
  ArrowDownWideNarrow,
  ArrowLeft,
  Check,
  DollarSign,
  Flame,
  Info,
  Scale,
  Search,
  Wand2,
  X,
} from "lucide-react";
import { toast } from "@/components/ui/Toaster";
import { fmtCount, fmtUsd } from "@/lib/fmt";
import { SUPER_CATEGORIES } from "@/lib/ingredients/categories";
import { RowSendBackButton } from "./RowSendBackButton";
import { MasterSendAllBackButton } from "./MasterSendAllBackButton";

// The four problems the bad-pack radar actually finds. They have
// different fixes, so they are reported separately rather than as one
// "flagged" boolean. "band" is the pre-existing absolute-range check.
export type MasterIssue = "spread" | "coverage" | "mismatch" | "outlier" | "band";

export type MasterLinkedItem = {
  id: string;
  name: string;
  vendor: string;
  perBase: number | null;
  perBaseUom: string | null;
  // true when the stored price_estimate.base_uom couldn't be
  // converted to the master's base_unit (different dimension; e.g.
  // the pack parse wrote $/LB but the master is 'each').
  unitMismatch: boolean;
  // true when this item's converted per-base sits more than 3x above
  // or below the master's blend. Never set on a unit-mismatched item -
  // its number is in a different dimension, so the comparison would be
  // meaningless. Computed server-side so the client and the master-
  // level flag cannot drift apart.
  outlier: boolean;
  usd12m: number;
};

export type MasterRow = {
  id: string;
  name: string;
  parent: string | null;
  category: string | null;
  baseUnit: string;
  resale: boolean;
  linkedCount: number;
  usd12m: number;
  avgPerBase: number | null;
  minPerBase: number | null;
  maxPerBase: number | null;
  spreadRatio: number | null;
  baseUom: string | null;
  flagged: boolean;
  flagReason: string | null;
  // How many of linkedCount actually contributed a per-base value to
  // the blend above. pricedCount < linkedCount means avgPerBase
  // describes a subset, and unpricedUsd is the 12-month spend sitting
  // outside it.
  pricedCount: number;
  unpricedUsd: number;
  issues: MasterIssue[];
  // The base_unit this master's own priced items agree on, when that
  // disagrees with the master's current one. Null when they agree or
  // the vote is inconclusive. A suggestion only - see Prompt R1.
  suggestedBaseUnit: string | null;
  linkedItems: MasterLinkedItem[];
};

type SortMode = "spend" | "name" | "links" | "spread";
type ResaleFilter = "all" | "recipe" | "resale";

// Badge wording. Short enough to sit inline on the row's sub-line, and
// each one names the fix: "Coverage" means links are missing a price,
// "Unit" means a dimension mismatch, not a wrong number.
const ISSUE_LABEL: Record<string, string> = {
  spread: "Spread",
  coverage: "Coverage",
  mismatch: "Unit",
  outlier: "Outlier",
  band: "Out of band",
};

function uomLabel(uom: string | null): string {
  if (!uom) return "unit";
  if (uom === "LB") return "lb";
  if (uom === "FLOZ") return "fl oz";
  if (uom === "EA") return "each";
  return uom.toLowerCase();
}

function matches(row: MasterRow, needle: string): boolean {
  if (!needle) return true;
  const n = needle.toLowerCase();
  if (row.name.toLowerCase().includes(n)) return true;
  if (row.parent && row.parent.toLowerCase().includes(n)) return true;
  if (row.category && row.category.toLowerCase().includes(n)) return true;
  for (const li of row.linkedItems) {
    if (li.name.toLowerCase().includes(n)) return true;
    if (li.vendor.toLowerCase().includes(n)) return true;
  }
  return false;
}

export function IngredientMastersFilter({ rows }: { rows: MasterRow[] }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("spend");
  const [superCat, setSuperCat] = useState<string | "all">("all");
  const [resaleFilter, setResaleFilter] = useState<ResaleFilter>("all");
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  // Workbench selection. `selId` is the user's explicit pick; the row
  // actually shown falls back to the first row in the current filter, so
  // the pane is never empty while the list has contents and a filter that
  // excludes the selection does not strand the pane on a hidden master.
  // Derived, not an effect - no render loop, no stale selection.
  const [selId, setSelId] = useState<string | null>(null);
  // On narrow viewports the index and the pane occupy the same space;
  // this says which one the user is looking at.
  const [paneOpen, setPaneOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // "/" focuses the input; Esc clears it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/") {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        return;
      }
      if (e.key === "Escape" && document.activeElement === inputRef.current) {
        e.preventDefault();
        setQuery("");
        inputRef.current?.blur();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const perSuperCount = useMemo(() => {
    const m = new Map<string, number>();
    m.set("all", rows.length);
    for (const c of SUPER_CATEGORIES) m.set(c, 0);
    for (const r of rows) {
      if (r.category && m.has(r.category)) m.set(r.category, (m.get(r.category) ?? 0) + 1);
    }
    return m;
  }, [rows]);

  const trimmed = query.trim();
  const filtered = useMemo(() => {
    let out = rows;
    if (trimmed) out = out.filter((r) => matches(r, trimmed));
    if (superCat !== "all") out = out.filter((r) => r.category === superCat);
    if (resaleFilter === "recipe") out = out.filter((r) => !r.resale);
    else if (resaleFilter === "resale") out = out.filter((r) => r.resale);
    if (onlyFlagged) out = out.filter((r) => r.issues.length > 0);
    if (sort === "name") out = [...out].sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "links") out = [...out].sort((a, b) => b.linkedCount - a.linkedCount);
    else if (sort === "spread") {
      out = [...out].sort((a, b) => (b.spreadRatio ?? 0) - (a.spreadRatio ?? 0));
    } else {
      out = [...out].sort((a, b) => b.usd12m - a.usd12m);
    }
    return out;
  }, [rows, trimmed, superCat, resaleFilter, onlyFlagged, sort]);

  // The row the pane shows. Explicit pick when there is one, else the
  // first row of the current filter - so the pane is never empty while
  // the list has contents, and a filter that hides the selection cannot
  // strand the pane on an invisible master. Derived, not an effect.
  const selected = useMemo(
    () => filtered.find((r) => r.id === selId) ?? filtered[0] ?? null,
    [filtered, selId]
  );
  const matchedUsd = useMemo(
    () => filtered.reduce((s, r) => s + r.usd12m, 0),
    [filtered]
  );
  const matchedFlagged = useMemo(
    () => filtered.filter((r) => r.issues.length > 0).length,
    [filtered]
  );
  // Whole-set count for the chip, so the chip and the "Needs attention"
  // tile above it can never disagree.
  const needsCount = useMemo(
    () => rows.filter((r) => r.issues.length > 0).length,
    [rows]
  );
  const anyFilterActive =
    trimmed.length > 0 ||
    superCat !== "all" ||
    resaleFilter !== "all" ||
    onlyFlagged;

  function clearAll() {
    setQuery("");
    setSuperCat("all");
    setResaleFilter("all");
    setOnlyFlagged(false);
    inputRef.current?.focus();
  }

  return (
    <>
      <div className="kf-review__search">
        <form
          className="kf-field kf-field--search kf-review__search-field"
          onSubmit={(e) => e.preventDefault()}
          role="search"
          aria-label="Filter masters"
        >
          <span className="kf-field__icon" aria-hidden>
            <Search size={16} strokeWidth={1.5} />
          </span>
          <input
            ref={inputRef}
            type="search"
            placeholder="Filter by name, parent, category, linked vendor or SKU"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter masters"
          />
          {trimmed.length > 0 ? (
            <button
              type="button"
              className="kf-field__clear"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              aria-label="Clear filter"
            >
              <X size={16} strokeWidth={1.5} />
            </button>
          ) : (
            <kbd className="kf-field__kbd" aria-hidden>/</kbd>
          )}
        </form>
        <span className="kf-review__search-count" aria-live="polite">
          {!anyFilterActive ? (
            <>
              <strong>{fmtCount(rows.length)}</strong> masters &middot;{" "}
              <strong>{fmtUsd(matchedUsd)}</strong>
            </>
          ) : (
            <>
              <strong>{fmtCount(filtered.length)}</strong> of {fmtCount(rows.length)}{" "}
              masters &middot; <strong>{fmtUsd(matchedUsd)}</strong>
              {matchedFlagged > 0 ? (
                <>
                  {" "}&middot; <strong>{fmtCount(matchedFlagged)}</strong> need attention
                </>
              ) : null}
            </>
          )}
        </span>
      </div>

      <div className="kf-review__toolbar" role="toolbar" aria-label="Sort and filter">
        <div className="kf-review__toolbar-group" role="radiogroup" aria-label="Sort order">
          <button
            type="button"
            role="radio"
            aria-checked={sort === "spend"}
            aria-pressed={sort === "spend"}
            className={`kf-chip${sort === "spend" ? " kf-chip--on" : ""}`}
            onClick={() => setSort("spend")}
            title="Highest annual spend first"
          >
            <DollarSign size={14} strokeWidth={1.5} aria-hidden />
            <span>Spend</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={sort === "name"}
            aria-pressed={sort === "name"}
            className={`kf-chip${sort === "name" ? " kf-chip--on" : ""}`}
            onClick={() => setSort("name")}
          >
            <ArrowDownAZ size={14} strokeWidth={1.5} aria-hidden />
            <span>A-Z</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={sort === "links"}
            aria-pressed={sort === "links"}
            className={`kf-chip${sort === "links" ? " kf-chip--on" : ""}`}
            onClick={() => setSort("links")}
            title="Most linked vendor items first"
          >
            <ArrowDownWideNarrow size={14} strokeWidth={1.5} aria-hidden />
            <span>Links</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={sort === "spread"}
            aria-pressed={sort === "spread"}
            className={`kf-chip${sort === "spread" ? " kf-chip--on" : ""}`}
            onClick={() => setSort("spread")}
            title="Widest price spread first (bad-pack radar)"
          >
            <Flame size={14} strokeWidth={1.5} aria-hidden />
            <span>Spread</span>
          </button>
        </div>

        <span className="kf-chips__sep" aria-hidden />

        <div className="kf-review__toolbar-group kf-review__cats" role="radiogroup" aria-label="Category filter">
          <button
            type="button"
            role="radio"
            aria-checked={superCat === "all"}
            aria-pressed={superCat === "all"}
            className={`kf-chip${superCat === "all" ? " kf-chip--on" : ""}`}
            onClick={() => setSuperCat("all")}
          >
            All <span className="kf-chip__count">{fmtCount(perSuperCount.get("all") ?? 0)}</span>
          </button>
          {SUPER_CATEGORIES.map((c) => {
            const n = perSuperCount.get(c) ?? 0;
            return (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={superCat === c}
                aria-pressed={superCat === c}
                className={`kf-chip${superCat === c ? " kf-chip--on" : ""}${n === 0 ? " kf-chip--empty" : ""}`}
                onClick={() => setSuperCat(c)}
                disabled={n === 0}
              >
                {c} <span className="kf-chip__count">{fmtCount(n)}</span>
              </button>
            );
          })}
        </div>

        <div className="kf-review__toolbar-group" role="radiogroup" aria-label="Resale and flag filters">
          <button
            type="button"
            role="radio"
            aria-checked={resaleFilter === "recipe"}
            aria-pressed={resaleFilter === "recipe"}
            className={`kf-chip${resaleFilter === "recipe" ? " kf-chip--on" : ""}`}
            onClick={() => setResaleFilter((v) => (v === "recipe" ? "all" : "recipe"))}
          >
            Recipe only
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={resaleFilter === "resale"}
            aria-pressed={resaleFilter === "resale"}
            className={`kf-chip${resaleFilter === "resale" ? " kf-chip--on" : ""}`}
            onClick={() => setResaleFilter((v) => (v === "resale" ? "all" : "resale"))}
          >
            Resale only
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={onlyFlagged}
            aria-pressed={onlyFlagged}
            className={`kf-chip kf-chip--warn${onlyFlagged ? " kf-chip--on" : ""}`}
            onClick={() => setOnlyFlagged((v) => !v)}
            title="Masters with a spread, coverage, unit or outlier issue"
          >
            Needs attention <span className="kf-chip__count">{fmtCount(needsCount)}</span>
          </button>
          {anyFilterActive ? (
            <button type="button" className="kf-btn kf-btn--ghost kf-btn--sm" onClick={clearAll}>
              Clear
            </button>
          ) : null}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="kf-empty">
          <div>
            <div className="kf-empty__title">No masters match the current filters</div>
            <div className="kf-empty__body">
              Try clearing filters, or widen the category.
            </div>
          </div>
          <button type="button" className="kf-btn kf-btn--soft kf-btn--sm" onClick={clearAll}>
            Clear filters
          </button>
        </div>
      ) : (
        <div className={`kf-wb${paneOpen ? " kf-wb--pane" : ""}`}>
          <div className="kf-wb__index">
            <div className="kf-masters__head" aria-hidden>
              <span>Ingredient</span>
              <span className="kf-masters__head-num">Per-unit</span>
              <span className="kf-masters__head-num">12-mo</span>
            </div>
            <div className="kf-masters__legend">
              <span className="kf-master__bdg kf-master__bdg--spread">Spread</span>
              <span>cheapest to dearest over 3x</span>
              <span className="kf-master__bdg kf-master__bdg--coverage">Coverage</span>
              <span>some links carry no price</span>
              <span className="kf-master__bdg kf-master__bdg--mismatch">Unit</span>
              <span>priced in another dimension</span>
              <span className="kf-master__bdg kf-master__bdg--outlier">Outlier</span>
              <span>one item far from the blend</span>
            </div>
            <ul className="kf-masters__list" aria-label="Masters">
              {filtered.map((row) => (
                <li key={row.id}>
                  <MasterRowButton
                    row={row}
                    selected={selected?.id === row.id}
                    onSelect={() => {
                      setSelId(row.id);
                      setPaneOpen(true);
                    }}
                  />
                </li>
              ))}
            </ul>
          </div>
          <div className="kf-wb__detail">
            {selected ? (
              <MasterDetail row={selected} onBack={() => setPaneOpen(false)} />
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}

function MasterRowButton({
  row,
  selected,
  onSelect,
}: {
  row: MasterRow;
  selected: boolean;
  onSelect: () => void;
}) {
  const uom = uomLabel(row.baseUom);
  const lv = row.spreadRatio == null ? null : row.spreadRatio > 3 ? "hi" : row.spreadRatio > 2 ? "mid" : "ok";
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={`kf-master__row${row.issues.length > 0 ? " kf-master__row--flagged" : ""}`}
    >
      <span className="kf-master__name-col">
        <strong className="kf-master__name">{row.name}</strong>
        <span className="kf-master__sub">
          {row.category ? row.category : <em className="kf-muted">Needs category</em>}
          {row.parent ? <> &middot; {row.parent}</> : null}
          {row.resale ? <> &middot; <span className="kf-pill kf-pill--muted">Resale</span></> : null}
          {row.spreadRatio != null ? (
            <span className="kf-master__spr" title={`${fmtUsd(row.minPerBase ?? 0)} to ${fmtUsd(row.maxPerBase ?? 0)} per ${uom}`}>
              <span className="kf-master__spr-track">
                <span
                  className="kf-master__spr-fill"
                  data-lv={lv ?? undefined}
                  style={{
                    width: `${Math.max(
                      Math.min(Math.log(row.spreadRatio) / Math.log(20), 1) * 100,
                      6
                    )}%`,
                  }}
                />
              </span>
              <span className={`kf-master__spr-n${row.spreadRatio > 3 ? " kf-master__spr-n--hi" : ""}`}>
                {row.spreadRatio.toFixed(1)}x
              </span>
            </span>
          ) : null}
          {row.issues.map((k) => (
            <span key={k} className={`kf-master__bdg kf-master__bdg--${k}`}>
              {ISSUE_LABEL[k] ?? k}
            </span>
          ))}
        </span>
      </span>

      <span className="kf-master__price-col">
        {row.avgPerBase != null ? (
          <span>
            <strong>{fmtUsd(row.avgPerBase)}</strong>
            <span className="kf-muted"> / {uom}</span>
          </span>
        ) : (
          <span className="kf-muted">- / {row.baseUnit?.toLowerCase() ?? "unit"}</span>
        )}
        {row.linkedCount > 0 ? (
          <span
            className={`kf-master__cov${
              row.pricedCount < row.linkedCount ? " kf-master__cov--part" : ""
            }`}
          >
            <span className="kf-master__cov-track">
              <span
                className="kf-master__cov-fill"
                style={{ width: `${Math.round((row.pricedCount / row.linkedCount) * 100)}%` }}
              />
            </span>
            {fmtCount(row.pricedCount)} of {fmtCount(row.linkedCount)} priced
          </span>
        ) : null}
      </span>

      <span className="kf-master__spend-col">{fmtUsd(row.usd12m)}</span>
    </button>
  );
}

// The schema's CHECK constraint, in the order a chef would scan them.
// `dozen` is in the constraint and on exactly one master today; it stays
// available but last.
const BASE_UNITS: { value: string; label: string }[] = [
  { value: "lb", label: "pound (lb)" },
  { value: "each", label: "each" },
  { value: "gal", label: "gallon (gal)" },
  { value: "dozen", label: "dozen" },
];

const BASE_UNIT_WORD: Record<string, string> = {
  lb: "pounds",
  each: "each",
  gal: "gallons",
  dozen: "dozens",
};

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: unknown = null;
  try { data = await res.json(); } catch { /* ignore */ }
  return { ok: res.ok, status: res.status, data };
}

function errText(data: unknown, fallback: string): string {
  if (data && typeof data === "object" && "error" in data && typeof (data as { error?: unknown }).error === "string") {
    return (data as { error: string }).error;
  }
  return fallback;
}

// Writes pr_ingredients.base_unit. The blend is computed from this on
// every render, so a successful save + router.refresh() is the whole
// story: the pane's per-unit price, spread, coverage and issue badges
// all re-derive. Reversible by picking the old value back.
function BaseUnitControl({ row }: { row: MasterRow }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function save(next: string) {
    if (next === row.baseUnit || busy) return;
    setBusy(true);
    const r = await postJson("/api/review/set-base-unit", {
      ingredientId: row.id,
      baseUnit: next,
    });
    if (!r.ok) {
      toast(errText(r.data, `Save failed (${r.status})`), { tone: "block" });
      setBusy(false);
      return;
    }
    toast(`${row.name} is now costed per ${next}`);
    setBusy(false);
    router.refresh();
  }

  return (
    <span className="kf-dt__unitctl">
      <Scale size={13} strokeWidth={1.5} aria-hidden />
      <label className="kf-dt__unitctl-l" htmlFor={`bu-${row.id}`}>
        Costed per
      </label>
      <select
        id={`bu-${row.id}`}
        className="kf-dt__unitsel"
        value={row.baseUnit}
        disabled={busy}
        onChange={(e) => save(e.target.value)}
      >
        {BASE_UNITS.map((u) => (
          <option key={u.value} value={u.value}>
            {u.label}
          </option>
        ))}
      </select>
    </span>
  );
}

// The one-click version of the same write, offered inside the mismatch
// note where the evidence for it is sitting.
function SuggestBaseUnitButton({ row }: { row: MasterRow }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const next = row.suggestedBaseUnit;
  if (!next) return null;

  async function apply() {
    if (busy || !next) return;
    setBusy(true);
    const r = await postJson("/api/review/set-base-unit", {
      ingredientId: row.id,
      baseUnit: next,
    });
    if (!r.ok) {
      toast(errText(r.data, `Save failed (${r.status})`), { tone: "block" });
      setBusy(false);
      return;
    }
    toast(`${row.name} is now costed per ${next}`);
    setBusy(false);
    router.refresh();
  }

  return (
    <button type="button" className="kf-btn kf-btn--sm kf-why__fix" onClick={apply} disabled={busy}>
      <Wand2 size={13} strokeWidth={1.5} aria-hidden />
      {busy ? "Switching…" : `Cost this per ${BASE_UNIT_WORD[next] ?? next} instead`}
    </button>
  );
}

// Typed, plain-English reasons. The whole point of PR52: the badge names
// the problem, this names the fix. Nothing here is hover-only.
function IssueNote({ row }: { row: MasterRow }) {
  const uom = uomLabel(row.baseUom);
  const notes: { tone: string; icon: ReactNode; head: string; body: ReactNode }[] = [];

  if (row.issues.includes("spread")) {
    notes.push({
      tone: "bad",
      icon: <Flame size={16} strokeWidth={1.5} aria-hidden />,
      head: `Spread is ${row.spreadRatio?.toFixed(1)}x`,
      body: (
        <>
          Cheapest linked item is {fmtUsd(row.minPerBase ?? 0)}/{uom}, dearest is{" "}
          {fmtUsd(row.maxPerBase ?? 0)}/{uom}. Over 3x usually means one item has a bad pack
          size, not a real price difference.
        </>
      ),
    });
  }
  if (row.issues.includes("coverage")) {
    notes.push({
      tone: "warn",
      icon: <AlertTriangle size={16} strokeWidth={1.5} aria-hidden />,
      head: `${fmtCount(row.linkedCount - row.pricedCount)} of ${fmtCount(row.linkedCount)} linked items are not in this price`,
      body: (
        <>
          <strong>{fmtUsd(row.unpricedUsd)}</strong> of this ingredient&rsquo;s{" "}
          {fmtUsd(row.usd12m)} sits outside the blend - either no per-unit price at all, or a
          price in a different unit. The figure above describes {fmtCount(row.pricedCount)}{" "}
          item{row.pricedCount === 1 ? "" : "s"}, not {fmtCount(row.linkedCount)}.
        </>
      ),
    });
  }
  if (row.issues.includes("mismatch")) {
    const n = row.linkedItems.filter((li) => li.unitMismatch).length;
    notes.push({
      tone: "info",
      icon: <Info size={16} strokeWidth={1.5} aria-hidden />,
      head: `${fmtCount(n)} item${n === 1 ? "" : "s"} priced in a different unit`,
      body: (
        <>
          This master is costed per <strong>{uom}</strong>, but {n === 1 ? "an item is" : "those items are"}{" "}
          priced per a different dimension. Those numbers are not comparable and never reach
          the blend until the unit is fixed.
          {row.suggestedBaseUnit ? (
            <>
              {" "}
              Most of its priced items are in{" "}
              <strong>{BASE_UNIT_WORD[row.suggestedBaseUnit] ?? row.suggestedBaseUnit}</strong>, so
              the ingredient is probably the one set wrong - it was created on the default.
              <SuggestBaseUnitButton row={row} />
            </>
          ) : null}
        </>
      ),
    });
  }
  if (row.issues.includes("outlier")) {
    const o = row.linkedItems.filter((li) => li.outlier);
    notes.push({
      tone: "bad",
      icon: <AlertTriangle size={16} strokeWidth={1.5} aria-hidden />,
      head: `${fmtCount(o.length)} item${o.length === 1 ? "" : "s"} far from the blend`,
      body: (
        <>
          {o.map((li) => `${li.name} at ${fmtUsd(li.perBase ?? 0)}/${uomLabel(li.perBaseUom)}`).join("; ")}
          . Blend is {fmtUsd(row.avgPerBase ?? 0)}/{uom}.
        </>
      ),
    });
  }
  if (row.issues.includes("band")) {
    notes.push({
      tone: "warn",
      icon: <AlertTriangle size={16} strokeWidth={1.5} aria-hidden />,
      head: "Average is outside the typical band for this unit",
      body: <>A soft signal, not an assertion - worth a look at the pack sizes.</>,
    });
  }

  if (notes.length === 0) {
    return (
      <div className="kf-why kf-why--good">
        <Check size={16} strokeWidth={1.5} aria-hidden />
        <div>
          <b>Nothing flagged</b>
          <span>
            All {fmtCount(row.linkedCount)} linked items carry a price, in one unit, inside the
            expected band.
          </span>
        </div>
      </div>
    );
  }
  return (
    <>
      {notes.map((n) => (
        <div key={n.head} className={`kf-why kf-why--${n.tone}`}>
          {n.icon}
          <div>
            <b>{n.head}</b>
            <span>{n.body}</span>
          </div>
        </div>
      ))}
    </>
  );
}

function MasterDetail({ row, onBack }: { row: MasterRow; onBack: () => void }) {
  const uom = uomLabel(row.baseUom);
  const partial = row.pricedCount < row.linkedCount;
  return (
    <div className="kf-dt">
      <div className="kf-dt__head">
        <button type="button" className="kf-btn kf-btn--ghost kf-btn--sm kf-dt__back" onClick={onBack}>
          <ArrowLeft size={14} strokeWidth={1.5} aria-hidden /> All ingredients
        </button>
        <div className="kf-dt__eyebrow">
          {row.category ?? "Needs category"}
          {row.parent ? ` · ${row.parent}` : ""}
        </div>
        <h3 className="kf-dt__title">{row.name}</h3>
        <div className="kf-dt__meta">
          {row.issues.map((k) => (
            <span key={k} className={`kf-master__bdg kf-master__bdg--${k}`}>
              {ISSUE_LABEL[k] ?? k}
            </span>
          ))}
          {row.resale ? <span className="kf-pill kf-pill--muted">Resale</span> : null}
          <BaseUnitControl row={row} />
        </div>
      </div>

      <div className="kf-dt__stats">
        <div className="kf-dt__stat">
          <span className="kf-dt__stat-l">Per-unit</span>
          <strong>{row.avgPerBase != null ? fmtUsd(row.avgPerBase) : "-"}</strong>
          <span className="kf-dt__stat-n">per {uom}</span>
        </div>
        <div className={`kf-dt__stat${row.spreadRatio != null && row.spreadRatio > 3 ? " kf-dt__stat--bad" : ""}`}>
          <span className="kf-dt__stat-l">Spread</span>
          <strong>{row.spreadRatio != null ? `${row.spreadRatio.toFixed(1)}x` : "-"}</strong>
          <span className="kf-dt__stat-n">
            {row.minPerBase != null && row.maxPerBase != null
              ? `${fmtUsd(row.minPerBase)} - ${fmtUsd(row.maxPerBase)}`
              : "no priced items"}
          </span>
        </div>
        <div className={`kf-dt__stat${partial ? " kf-dt__stat--warn" : ""}`}>
          <span className="kf-dt__stat-l">In this price</span>
          <strong>
            {fmtCount(row.pricedCount)} of {fmtCount(row.linkedCount)}
          </strong>
          <span className="kf-dt__stat-n">
            {partial ? `${fmtUsd(row.unpricedUsd)} outside` : "all linked items"}
          </span>
        </div>
        <div className="kf-dt__stat">
          <span className="kf-dt__stat-l">12-mo spend</span>
          <strong>{fmtUsd(row.usd12m)}</strong>
          <span className="kf-dt__stat-n">{fmtCount(row.linkedCount)} linked items</span>
        </div>
      </div>

      <div className="kf-dt__sec">
        <h4 className="kf-dt__sec-h">What needs attention</h4>
        <IssueNote row={row} />
      </div>

      {row.linkedCount === 0 ? (
        <div className="kf-dt__sec">
          <div className="kf-empty">
            <div>
              <div className="kf-empty__title">No links yet</div>
              <div className="kf-empty__body">
                Awaiting confirmation in the review queue.
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="kf-dt__sec">
          <div className="kf-dt__sec-head">
            <h4 className="kf-dt__sec-h">Linked vendor items</h4>
            <MasterSendAllBackButton
              masterName={row.name}
              itemIds={row.linkedItems.map((li) => li.id)}
            />
          </div>
          <table className="kf-master__inner-table">
            <thead>
              <tr>
                <th>Vendor item</th>
                <th>Vendor</th>
                <th className="kf-table__num">Per-unit</th>
                <th className="kf-table__num">Annual $</th>
                <th aria-label="Open" />
              </tr>
            </thead>
            <tbody>
              {row.linkedItems.map((li) => {
                const liUom = uomLabel(li.perBaseUom);
                const outlier = li.outlier;
                return (
                  <tr
                    key={li.id}
                    className={outlier || li.unitMismatch ? "kf-master__inner-row--outlier" : undefined}
                  >
                    <td title={li.name}>
                      <span className="kf-cell-ellipsis">{li.name}</span>
                      {li.unitMismatch ? (
                        <span className="kf-cell-sub kf-cell-sub--note">
                          unit mismatch vs master ({li.perBaseUom ?? "?"})
                        </span>
                      ) : outlier ? (
                        <span className="kf-cell-sub kf-cell-sub--note">outlier vs blend</span>
                      ) : null}
                    </td>
                    <td>{li.vendor}</td>
                    <td className="kf-table__num">
                      {li.perBase != null ? (
                        <>
                          <strong>{fmtUsd(li.perBase)}</strong>
                          <span className="kf-muted"> / {liUom}</span>
                        </>
                      ) : (
                        <span className="kf-muted">-</span>
                      )}
                    </td>
                    <td className="kf-table__num">{fmtUsd(li.usd12m)}</td>
                    <td className="kf-table__num">
                      <span className="kf-dt__rowacts">
                        <RowSendBackButton itemId={li.id} itemName={li.name} />
                        <a
                          href={`/stockpot/ingredients/vendor-items?drawer=${li.id}`}
                          className="kf-btn kf-btn--line kf-btn--sm"
                        >
                          Open
                        </a>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
