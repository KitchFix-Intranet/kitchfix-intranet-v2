"use client";

// Train 5a / F22: one search box, used on every Stockpot Ingredients
// working tab. Shape and behaviour come from the approved proposal in
// docs/renders/INGREDIENTS_V1_PROPOSAL.css part B (the .kf-search
// primitive) and the reference's `searchBox()` function.
//
// Behaviour:
// - Filters as you type (no Enter required).
// - "/" from anywhere on the page that is not a text field moves
//   the cursor into this box and selects its contents.
// - Esc with text clears; Esc with it empty blurs (the previous
//   behaviour the three tabs had).
// - A clear button shows when it holds text; a "/" hint shows when
//   it is empty.
// - The placeholder lists only what the tab really searches - the
//   caller passes exactly the right words.
//
// The caller owns the string. Two modes:
// - `value` + `onChange`: a controlled input over local state (every
//   keystroke drives a filter over data already in memory). This is
//   what Review queue, Ingredients and Retail use.
// - `initial` + `onCommit`: the parent reads the string only after
//   a debounce or Enter, used by Vendor items whose search is in
//   the address (ruling 6: 250 ms replace-not-push, Enter is
//   immediate).

import { Search as SearchIcon, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export type SearchProps =
  // Controlled - parent owns the string; every keystroke bubbles up.
  | {
      kind: "controlled";
      value: string;
      onChange: (v: string) => void;
      placeholder: string;
      label: string;
    }
  // Debounced - parent gets a committed string after `debounceMs`
  // of quiet, or at once on Enter. Enter never fires twice.
  | {
      kind: "debounced";
      initial: string;
      onCommit: (v: string) => void;
      debounceMs?: number;
      placeholder: string;
      label: string;
    };

export function Search(props: SearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // The input's live string always lives in local state; the parent
  // is told about it either synchronously (controlled) or after a
  // debounce (debounced).
  const [internal, setInternal] = useState<string>(
    props.kind === "controlled" ? props.value : props.initial,
  );
  const value = props.kind === "controlled" ? props.value : internal;

  // Train 5a R2 / fix 2: the box must always show the search the
  // address holds. `lastCommittedRef` tracks what we last pushed
  // upstream so the next `initial` change is classifiable:
  //   - if it equals lastCommitted, the URL is catching up with
  //     our own debounced commit; leave `internal` alone (the user
  //     is still typing in a newer string).
  //   - if it differs, the address changed from outside this box
  //     (Back / Forward, a link, a clear-from-elsewhere). Reset
  //     `internal` to the new initial and align lastCommitted.
  // Enter, the clear button and the three keystrokes a one-shot
  // commit cycle both go through `commitNow()` so lastCommitted is
  // always in step.
  const lastCommittedRef = useRef<string>(
    props.kind === "debounced" ? props.initial : "",
  );

  // Keep local state in sync with a controlled parent (back/forward
  // navigation can swap the value underneath).
  useEffect(() => {
    if (props.kind === "controlled") setInternal(props.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.kind === "controlled" ? props.value : undefined]);

  // Train 5a R2 / fix 2: watch `initial` in debounced mode. On
  // external change, match the box to the address.
  useEffect(() => {
    if (props.kind !== "debounced") return;
    if (props.initial === lastCommittedRef.current) return;
    lastCommittedRef.current = props.initial;
    setInternal(props.initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.kind === "debounced" ? props.initial : undefined]);

  // Debounced commit.
  useEffect(() => {
    if (props.kind !== "debounced") return;
    const ms = props.debounceMs ?? 250;
    const h = window.setTimeout(() => {
      if (internal !== lastCommittedRef.current) {
        lastCommittedRef.current = internal;
        props.onCommit(internal);
      }
    }, ms);
    return () => window.clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [internal]);

  // Global "/" hotkey. Scoped to the page, not the shortcut inside
  // another input/textarea.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/") {
        const tag = (e.target as HTMLElement | null)?.tagName;
        const editable = (e.target as HTMLElement | null)?.isContentEditable;
        if (tag === "INPUT" || tag === "TEXTAREA" || editable) return;
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  function setText(v: string) {
    if (props.kind === "controlled") {
      props.onChange(v);
    } else {
      setInternal(v);
    }
  }

  function clearText() {
    if (props.kind === "controlled") {
      props.onChange("");
    } else {
      setInternal("");
      lastCommittedRef.current = "";
      props.onCommit("");
    }
  }

  return (
    <label className="kf-search" role="search" aria-label={props.label}>
      <SearchIcon size={16} strokeWidth={1.5} aria-hidden />
      <input
        ref={inputRef}
        type="search"
        value={value}
        placeholder={props.placeholder}
        aria-label={props.label}
        autoComplete="off"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            if (value.length > 0) {
              e.preventDefault();
              clearText();
            } else {
              inputRef.current?.blur();
            }
          } else if (e.key === "Enter" && props.kind === "debounced") {
            e.preventDefault();
            lastCommittedRef.current = internal;
            props.onCommit(internal);
          }
        }}
      />
      {value ? (
        <button
          type="button"
          className="kf-search__clear"
          aria-label="Clear the search"
          onClick={() => {
            clearText();
            inputRef.current?.focus();
          }}
        >
          <X size={16} strokeWidth={1.5} aria-hidden />
        </button>
      ) : (
        <kbd className="kf-search__kbd" aria-hidden>
          /
        </kbd>
      )}
    </label>
  );
}
