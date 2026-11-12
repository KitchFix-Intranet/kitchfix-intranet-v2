"use client";

// T4b-1 (2026-11-14). People lane dropdown (R-PP23). Matches the
// render's .kf-pe-select pattern:
//
//   <div class="kf-pe-select">
//     <button class="kf-pe-select__btn"
//             aria-haspopup="listbox" aria-expanded="...">
//       <span class="kf-pe-select__val">...</span>
//       <svg> chevron down </svg>
//     </button>
//     <ul class="kf-pe-menu" role="listbox" hidden?>
//       <li role="option" aria-selected="...">
//         <svg> check (only when selected) </svg>
//         <span>...</span>
//       </li>
//       ...
//     </ul>
//   </div>
//
// Keyboard:
//   - Enter or Space on the button: opens the menu + focuses
//     the current item (or first).
//   - ArrowUp / ArrowDown: moves focus through items.
//   - Home / End: jump to first / last.
//   - Letter keys: jump to the next item whose label starts
//     with that letter (case-insensitive).
//   - Enter / Space on an item: selects + closes.
//   - Escape: closes + returns focus to the button.
//
// Phone visibility (T4a.1 Part 0 #5 extended): when the menu
// would overflow below the viewport minus the fixed tab bar + sheet
// footer, it opens upward instead. On narrow screens it also
// scrolls the trigger into view before opening.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";

export interface SelectOption {
  value: string;
  label: string;
}

type Props = {
  id?: string;
  value: string | null;
  options: readonly SelectOption[];
  onChange: (next: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  // For the Reclassification "To" dropdown: pass the "From"
  // value so the matching option can be disabled. Null = no filter.
  disabledValue?: string | null;
};

// Vertical space from the bottom of the button to the viewport
// bottom, minus a small gap for the fixed tab bar + sheet footer.
// Used to decide whether to open upward.
const PHONE_TABBAR = 56;
const PHONE_SHEET_FOOTER = 72;
const PHONE_GAP = PHONE_TABBAR + PHONE_SHEET_FOOTER + 12;

export function Select({
  id, value, options, onChange, placeholder = "Pick one",
  ariaLabel, disabledValue = null,
}: Props) {
  const [open, setOpen] = useState(false);
  const [openUp, setOpenUp] = useState(false);
  const [focusIndex, setFocusIndex] = useState(-1);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);
  const listId = useMemo(() => id ? `${id}-menu` : undefined, [id]);

  const activeIndex = useMemo(
    () => Math.max(0, options.findIndex((o) => o.value === value)),
    [options, value],
  );

  const openMenu = useCallback(() => {
    if (open) return;
    // Decide open direction. On phone-width the fixed tab bar + the
    // fixed sheet footer eat the bottom of the viewport.
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      const spaceBelow = window.innerHeight - r.bottom - (window.innerWidth <= 640 ? PHONE_GAP : 24);
      const spaceAbove = r.top - 24;
      const needed = Math.min(options.length * 48 + 16, 360);
      setOpenUp(spaceBelow < needed && spaceAbove > spaceBelow);
    }
    setOpen(true);
    setFocusIndex(activeIndex);
    // Scroll the trigger into view on phone so the menu fits.
    if (window.innerWidth <= 640) {
      requestAnimationFrame(() => {
        btnRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    }
  }, [open, options.length, activeIndex]);

  const closeMenu = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => { btnRef.current?.focus(); });
  }, []);

  const pickIndex = useCallback((i: number) => {
    const opt = options[i];
    if (!opt) return;
    if (opt.value === disabledValue) return;
    onChange(opt.value);
    closeMenu();
  }, [options, onChange, closeMenu, disabledValue]);

  // Letter jump: type a letter and the next matching option gets focus.
  const letterBufferRef = useRef("");
  const letterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const letterJump = useCallback((letter: string) => {
    if (letterTimerRef.current) clearTimeout(letterTimerRef.current);
    letterBufferRef.current = (letterBufferRef.current + letter).slice(-6);
    const buf = letterBufferRef.current.toLowerCase();
    const start = focusIndex >= 0 ? focusIndex + 1 : 0;
    for (let n = 0; n < options.length; n += 1) {
      const i = (start + n) % options.length;
      if (options[i].label.toLowerCase().startsWith(buf)) {
        setFocusIndex(i);
        return;
      }
    }
    letterTimerRef.current = setTimeout(() => { letterBufferRef.current = ""; }, 700);
  }, [options, focusIndex]);

  const onKey = useCallback((e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); closeMenu(); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusIndex((i) => Math.min(options.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Home") { e.preventDefault(); setFocusIndex(0); return; }
    if (e.key === "End") { e.preventDefault(); setFocusIndex(options.length - 1); return; }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (focusIndex >= 0) pickIndex(focusIndex);
      return;
    }
    if (e.key.length === 1 && /[a-z0-9]/i.test(e.key)) {
      letterJump(e.key);
    }
  }, [open, openMenu, closeMenu, options.length, focusIndex, pickIndex, letterJump]);

  // Click outside closes.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node | null;
      if (!t) return;
      if (btnRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Move focus to the current focusIndex option when the menu is
  // open or the index changes.
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      const li = menuRef.current?.querySelector<HTMLLIElement>(`[data-i="${focusIndex}"]`);
      li?.focus();
    });
  }, [open, focusIndex]);

  const displayLabel = useMemo(() => {
    const found = options.find((o) => o.value === value);
    return found?.label ?? "";
  }, [options, value]);

  return (
    <div className="kf-pe-select">
      <button
        ref={btnRef}
        id={id}
        type="button"
        className="kf-pe-select__btn"
        aria-haspopup="listbox"
        aria-expanded={open ? "true" : "false"}
        aria-controls={listId}
        aria-label={ariaLabel}
        onClick={() => (open ? closeMenu(false) : openMenu())}
        onKeyDown={onKey}
      >
        <span className="kf-pe-select__val">
          {displayLabel || <span className="kf-pe-muted">{placeholder}</span>}
        </span>
        <ChevronDown size={18} strokeWidth={1.5} aria-hidden />
      </button>
      <ul
        ref={menuRef}
        id={listId}
        className={`kf-pe-menu${openUp ? " kf-pe-menu--up" : ""}`}
        role="listbox"
        hidden={!open}
        onKeyDown={onKey}
        tabIndex={-1}
      >
        {options.map((opt, i) => {
          const selected = opt.value === value;
          const disabled = opt.value === disabledValue;
          return (
            <li
              key={opt.value}
              role="option"
              aria-selected={selected ? "true" : "false"}
              aria-disabled={disabled ? "true" : undefined}
              tabIndex={-1}
              data-i={i}
              className={disabled ? "is-disabled" : undefined}
              onClick={() => pickIndex(i)}
            >
              <span className="kf-pe-menu__check" aria-hidden>
                {selected ? <Check size={16} strokeWidth={1.5} /> : null}
              </span>
              <span>{opt.label}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
