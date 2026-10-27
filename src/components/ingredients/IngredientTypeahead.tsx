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

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";

type Ingredient = { id: string; name: string; parent: string | null };

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

export function IngredientTypeahead({
  ingredients,
  excludeId,
  placeholder = "Type to search ingredients...",
  label,
  pickedId,
  onPick,
  busy = false,
}: {
  ingredients: Ingredient[];
  excludeId?: string | null;
  placeholder?: string;
  label: string;
  pickedId: string | null;
  onPick: (id: string | null, name: string | null) => void;
  busy?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // When pickedId arrives via prop, reflect it as the input value so the
  // picker is visibly committed. User typing re-opens the dropdown.
  useEffect(() => {
    if (!pickedId) return;
    const match = ingredients.find((i) => i.id === pickedId);
    if (match) setQuery(match.name);
  }, [pickedId, ingredients]);

  const filtered = useMemo(() => {
    const pool = excludeId ? ingredients.filter((i) => i.id !== excludeId) : ingredients;
    const list = pool.filter((i) => matches(i, query.trim()));
    return list.slice(0, MAX_RESULTS);
  }, [ingredients, excludeId, query]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

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

  return (
    <div className="kf-ingtype">
      <label className="kf-dpn__label">
        <span>{label}</span>
        <div className="kf-ingtype__field">
          <span className="kf-field__icon" aria-hidden>
            <Search size={16} strokeWidth={1.5} />
          </span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            placeholder={placeholder}
            onFocus={() => setOpen(true)}
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

      {open && filtered.length > 0 ? (
        <ul
          id="kf-ingtype-list"
          role="listbox"
          className="kf-ingtype__list"
          onMouseDown={(e) => e.preventDefault() /* keep focus on input */}
        >
          {filtered.map((ing, i) => (
            <li
              key={ing.id}
              role="option"
              aria-selected={i === cursor}
              className={`kf-ingtype__opt${i === cursor ? " kf-ingtype__opt--on" : ""}`}
              onClick={() => commit(ing)}
              onMouseEnter={() => setCursor(i)}
            >
              <span className="kf-ingtype__name">{ing.name}</span>
              {ing.parent ? <span className="kf-ingtype__parent">{ing.parent}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {open && filtered.length === 0 && query.trim().length > 0 ? (
        <div className="kf-ingtype__empty">No active ingredients match &ldquo;{query.trim()}&rdquo;.</div>
      ) : null}
    </div>
  );
}
