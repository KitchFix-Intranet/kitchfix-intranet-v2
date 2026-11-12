"use client";

// Shared type-to-search ingredient picker. Used by:
//   - ReviewActions relink panel (replace the long <select>)
//   - DetailPanel merge section (same)
//
// Narrow API: pass the full active-ingredients list; the component owns
// its own filter + highlight state and calls onPick(id) when the user
// commits (click or Enter). Keyboard: ArrowUp / ArrowDown navigate the
// results; Enter picks the highlighted; Esc clears. Up to 12 results
// render at a time so the panel never grows past the fold.
//
// Casing rule: ingredient names are shown as-is (sentence case per the
// house standard - the writer owns the display case; parents in muted
// after a dash). No text-transform on names.
//
// Polish 2 (2026-11-02):
//   - Menu portaled to document.body with position:fixed anchored to
//     the input's bounding rect. Why: the Review-queue card
//     (.kf-rvc, overflow:clip) clipped the dropdown mid-list. The
//     fix is to leave the card untouched and render the menu above
//     the card's clipping context.
//   - Dismiss triggers: outside pointerdown, Escape (already), and
//     input blur. Blur is guarded against the "option mousedown"
//     case by the <ul>'s own onMouseDown preventDefault (focus never
//     leaves the input while committing a pick).
//   - Styling (border/outline/icon padding/clear-x) handled in
//     review.css at the .kf-ingtype__field selector family.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search, X } from "lucide-react";
import { uomLabel } from "@/lib/ingredients/pack";
// N13.1 R2: own the sheet instead of depending on each host page
// loading review.css. Mounts in three places (panel on every surface,
// review-queue ReviewActions, admin MatchRunButton); each one now
// picks up the field + list rules through this import.
import "./ingredient-typeahead.css";

// N10 §2e + R3 + R7: optional category + base_unit let the typeahead
// render a second micro line on each result (`showResultMeta`).
// Required for the Relink flow, opt-in so PanelClosedRows' Merge
// disclosure (which passes a different shape) is byte-identical.
type Ingredient = {
  id: string;
  name: string;
  parent: string | null;
  category?: string | null;
  base_unit?: string;
};

const MAX_RESULTS = 12;

function norm(s: string): string {
  return s.toLowerCase();
}

function matches(ing: Ingredient, needle: string): boolean {
  if (needle.length === 0) return true;
  const n = norm(needle);
  if (norm(ing.name).includes(n)) return true;
  if (ing.parent && norm(ing.parent).includes(n)) return true;
  return false;
}

// N10 §2e R7: shared meta-line formatter. The picked card (frame G)
// renders the same string, from the same function, so the search and
// the picked state cannot drift.
export function formatIngredientMeta(ing: Ingredient): string | null {
  const bits: string[] = [];
  if (ing.category) bits.push(ing.category);
  if (ing.parent) bits.push(ing.parent);
  if (ing.base_unit) bits.push(`per ${uomLabel(ing.base_unit)}`);
  return bits.length > 0 ? bits.join(" · ") : null;
}

export function IngredientTypeahead({
  ingredients,
  excludeId,
  placeholder = "Type to search ingredients...",
  label,
  pickedId,
  onPick,
  busy = false,
  showResultMeta = false,
  autoFocusInput = false,
  initialQuery = "",
  selectOnFocus = false,
}: {
  ingredients: Ingredient[];
  excludeId?: string | null;
  placeholder?: string;
  label: string;
  pickedId: string | null;
  onPick: (id: string | null, name: string | null) => void;
  busy?: boolean;
  // N10 §2e: opt-in. Relink turns it on; PanelClosedRows (Merge) leaves
  // it off so the Merge dropdown is byte-identical to today.
  showResultMeta?: boolean;
  // N10 round 2 fix 3: Relink wants focus in the search when the
  // panel opens. Other call sites leave this off.
  autoFocusInput?: boolean;
  // N10 round 2 fix 4: Change returns to the search with the
  // previously-picked name pre-filled. Seeds the internal query on
  // mount only.
  initialQuery?: string;
  // N10 round 2 fix 4: with initialQuery + autoFocusInput, select
  // the text on the first focus so a keystroke replaces it.
  selectOnFocus?: boolean;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  // Anchor rect for the portaled menu. Null until the component mounts
  // in the browser (createPortal needs document.body). Updated on open
  // and on scroll/resize while open so a scrolling card does not
  // detach the menu from its input.
  const [anchor, setAnchor] = useState<{ top: number; left: number; width: number } | null>(null);

  // When pickedId arrives via prop, reflect it as the input value so the
  // picker is visibly committed. User typing re-opens the dropdown.
  useEffect(() => {
    if (!pickedId) return;
    const match = ingredients.find((i) => i.id === pickedId);
    if (match) setQuery(match.name);
  }, [pickedId, ingredients]);

  // N10 round 2 fix 3 + 4: optional autoFocus on the input, optional
  // select-all on the first focus so a typed key replaces the seed.
  useEffect(() => {
    if (!autoFocusInput) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (selectOnFocus) el.select();
    // Once; mount-time only. Deps left narrow by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const pool = excludeId ? ingredients.filter((i) => i.id !== excludeId) : ingredients;
    const list = pool.filter((i) => matches(i, query.trim()));
    return list.slice(0, MAX_RESULTS);
  }, [ingredients, excludeId, query]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  const measure = useCallback(() => {
    const el = fieldRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setAnchor({ top: r.bottom + 2, left: r.left, width: r.width });
  }, []);

  // Measure on open, and keep the menu glued to the input as any
  // ancestor scrolls (capture:true catches scroll in nested
  // containers, not just window). Resize covers viewport changes.
  useLayoutEffect(() => {
    if (!open) return;
    measure();
    const onScroll = () => measure();
    const onResize = () => measure();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, measure]);

  // Outside pointerdown dismisses. Captures taps on non-focusable
  // regions where blur alone would not fire. Pointerdown fires before
  // the click that would blur the input, so we check containment
  // against both the field and the (portaled) menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (fieldRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  function commit(ing: Ingredient) {
    onPick(ing.id, ing.name);
    setQuery(ing.name);
    setOpen(false);
  }

  function clear() {
    onPick(null, null);
    setQuery("");
    inputRef.current?.focus();
    setOpen(true);
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setCursor((c) => Math.min(c + 1, Math.max(0, filtered.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === "Enter") {
      if (!open || filtered.length === 0) return;
      e.preventDefault();
      const pick = filtered[cursor] ?? filtered[0];
      if (pick) commit(pick);
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
    }
  }

  // Blur dismisses, with a guard: if the next focus target lives
  // inside the field or the menu, keep open. The <ul>'s own
  // onMouseDown preventDefault keeps focus on the input during an
  // option click, so blur fires only for genuine out-of-widget focus
  // moves (Tab to next field, click on non-focusable background).
  function onBlur(e: React.FocusEvent<HTMLInputElement>) {
    const next = e.relatedTarget as Node | null;
    if (next && (fieldRef.current?.contains(next) || menuRef.current?.contains(next))) return;
    setOpen(false);
  }

  const showList = open && filtered.length > 0 && anchor != null;
  const showEmpty = open && filtered.length === 0 && query.trim().length > 0 && anchor != null;

  return (
    <div className="kf-ingtype">
      <label className="kf-dpn__label">
        <span>{label}</span>
        <div className="kf-ingtype__field" ref={fieldRef}>
          <span className="kf-field__icon" aria-hidden>
            <Search size={16} strokeWidth={1.5} />
          </span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            placeholder={placeholder}
            onFocus={() => setOpen(true)}
            onBlur={onBlur}
            onChange={(e) => {
              const v = e.target.value;
              setQuery(v);
              setOpen(true);
              if (pickedId) onPick(null, null); // user is retyping; drop the pick
            }}
            onKeyDown={onKey}
            disabled={busy}
            aria-expanded={open}
            aria-controls="kf-ingtype-list"
            autoComplete="off"
          />
          {query.length > 0 ? (
            <button
              type="button"
              className="kf-field__clear"
              onClick={clear}
              aria-label="Clear"
              disabled={busy}
            >
              <X size={14} strokeWidth={1.5} />
            </button>
          ) : null}
        </div>
      </label>

      {typeof document !== "undefined" && showList
        ? createPortal(
            <ul
              id="kf-ingtype-list"
              role="listbox"
              className="kf-ingtype__list"
              ref={menuRef}
              style={{ top: anchor.top, left: anchor.left, width: anchor.width }}
              onMouseDown={(e) => e.preventDefault() /* keep focus on input */}
            >
              {filtered.map((ing, i) => {
                const meta = showResultMeta ? formatIngredientMeta(ing) : null;
                return (
                  <li
                    key={ing.id}
                    role="option"
                    aria-selected={i === cursor}
                    className={`kf-ingtype__opt${i === cursor ? " kf-ingtype__opt--on" : ""}`}
                    onClick={() => commit(ing)}
                    onMouseEnter={() => setCursor(i)}
                  >
                    <span className="kf-ingtype__name">{ing.name}</span>
                    {meta ? (
                      <span className="kf-ingtype__meta">{meta}</span>
                    ) : ing.parent ? (
                      <span className="kf-ingtype__parent">{ing.parent}</span>
                    ) : null}
                  </li>
                );
              })}
            </ul>,
            document.body
          )
        : null}
      {typeof document !== "undefined" && showEmpty
        ? createPortal(
            <div
              className="kf-ingtype__empty kf-ingtype__list"
              style={{ top: anchor.top, left: anchor.left, width: anchor.width, maxHeight: "none", padding: "var(--sp-sp-3)" }}
              onMouseDown={(e) => e.preventDefault()}
            >
              No active ingredients match &ldquo;{query.trim()}&rdquo;.
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
