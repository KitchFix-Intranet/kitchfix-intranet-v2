"use client";

// Custom date picker. Rebuilt in the People lane (R-PP23) because:
//   - native <input type="date"> is a popup we cannot style
//   - native <select> for month / year is a popup we cannot style
//   - the design needs the render's month grid + today marked +
//     keyboard navigation inside a labelled dialog
//
// API: `value` is a date-only string (YYYY-MM-DD) OR "". onChange
// fires with the same shape. No `Date` object leaves the component.
// Parsing is done from parts (year / month / day) so a bare
// YYYY-MM-DD never shifts across a time zone boundary.
//
// Keyboard: arrows move by day, PgUp / PgDown move by month, Home
// first of month, End last of month, Enter selects, Escape closes
// and returns focus to the trigger.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Calendar } from "lucide-react";
import { fmtFull } from "@/lib/people/dates";

const MONTHS_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function parseYMD(s: string | null | undefined): { y: number; m: number; d: number } | null {
  if (!s) return null;
  const ymd = s.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const [y, m, d] = ymd.split("-").map((x) => parseInt(x, 10));
  if (!y || !m || !d) return null;
  return { y, m, d };
}

function pad2(n: number): string { return String(n).padStart(2, "0"); }
function toYMD(y: number, m: number, d: number): string { return `${y}-${pad2(m)}-${pad2(d)}`; }

// Days in a given month (m is 1-based).
function daysInMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate();
}

// Day-of-week of the 1st of month (0..6, 0 = Sun). We use Date here
// only for the calendar grid; the value we read back is never
// serialised.
function dowOfFirst(y: number, m: number): number {
  return new Date(y, m - 1, 1).getDay();
}

// Today as {y, m, d} for the "today" ring. Uses the browser's local
// clock but only for rendering - the stored value is YYYY-MM-DD.
function todayParts(): { y: number; m: number; d: number } {
  const now = new Date();
  return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
}

function clampDay(y: number, m: number, d: number): number {
  const max = daysInMonth(y, m);
  return Math.min(Math.max(1, d), max);
}

function shiftDays(parts: { y: number; m: number; d: number }, delta: number) {
  // Use Date math then re-emit parts. One-day shifts never run
  // across a DST boundary wrong because we always read parts.
  const d = new Date(parts.y, parts.m - 1, parts.d);
  d.setDate(d.getDate() + delta);
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
}

function shiftMonths(parts: { y: number; m: number; d: number }, delta: number) {
  let y = parts.y;
  let m = parts.m + delta;
  while (m < 1) { y -= 1; m += 12; }
  while (m > 12) { y += 1; m -= 12; }
  return { y, m, d: clampDay(y, m, parts.d) };
}

export function DatePicker({
  id, value, onChange, placeholder = "Pick a date", hintId, errorId,
}: {
  id?: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  hintId?: string;
  errorId?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [cursor, setCursor] = useState(() => parseYMD(value) ?? todayParts());

  // Keep cursor in sync when the external value changes.
  useEffect(() => {
    const p = parseYMD(value);
    if (p) setCursor(p);
  }, [value]);

  // On open: focus the selected day (or today when no selection).
  useEffect(() => {
    if (!open) return;
    const want = parseYMD(value) ?? todayParts();
    setCursor(want);
    // focus after render
    requestAnimationFrame(() => {
      const root = popRef.current;
      if (!root) return;
      const sel = root.querySelector<HTMLButtonElement>(`[data-day="${want.d}"][data-current="true"]`);
      sel?.focus();
    });
  }, [open]);

  // Click-outside + Escape.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node | null;
      if (!t) return;
      if (popRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const displayValue = useMemo(() => {
    const p = parseYMD(value);
    return p ? fmtFull(value) : "";
  }, [value]);

  // Keyboard navigation inside the grid.
  const onGridKey = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    let next: { y: number; m: number; d: number } | null = null;
    if (e.key === "ArrowLeft") next = shiftDays(cursor, -1);
    else if (e.key === "ArrowRight") next = shiftDays(cursor, 1);
    else if (e.key === "ArrowUp") next = shiftDays(cursor, -7);
    else if (e.key === "ArrowDown") next = shiftDays(cursor, 7);
    else if (e.key === "PageUp") next = shiftMonths(cursor, -1);
    else if (e.key === "PageDown") next = shiftMonths(cursor, 1);
    else if (e.key === "Home") next = { ...cursor, d: 1 };
    else if (e.key === "End") next = { ...cursor, d: daysInMonth(cursor.y, cursor.m) };
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onChange(toYMD(cursor.y, cursor.m, cursor.d));
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (next) {
      e.preventDefault();
      setCursor(next);
      // Move focus to the new day cell after the DOM updates.
      requestAnimationFrame(() => {
        const root = popRef.current;
        if (!root) return;
        const cell = root.querySelector<HTMLButtonElement>(`[data-day="${next!.d}"][data-current="true"]`);
        cell?.focus();
      });
    }
  }, [cursor, onChange]);

  const sel = parseYMD(value);
  const today = todayParts();

  // Build the visible grid: previous-month trailing days, current
  // month days, next-month leading days. Six rows x seven columns.
  const grid: Array<{ y: number; m: number; d: number; current: boolean; today: boolean; selected: boolean }> = [];
  const firstDow = dowOfFirst(cursor.y, cursor.m);
  const daysCur = daysInMonth(cursor.y, cursor.m);
  const prev = shiftMonths(cursor, -1);
  const daysPrev = daysInMonth(prev.y, prev.m);
  // Leading cells from previous month.
  for (let i = firstDow - 1; i >= 0; i -= 1) {
    const d = daysPrev - i;
    grid.push({
      y: prev.y, m: prev.m, d,
      current: false,
      today: prev.y === today.y && prev.m === today.m && d === today.d,
      selected: !!sel && sel.y === prev.y && sel.m === prev.m && sel.d === d,
    });
  }
  // Current month.
  for (let d = 1; d <= daysCur; d += 1) {
    grid.push({
      y: cursor.y, m: cursor.m, d,
      current: true,
      today: cursor.y === today.y && cursor.m === today.m && d === today.d,
      selected: !!sel && sel.y === cursor.y && sel.m === cursor.m && sel.d === d,
    });
  }
  // Trailing cells from next month to fill 42.
  const next = shiftMonths(cursor, 1);
  let nd = 1;
  while (grid.length < 42) {
    grid.push({
      y: next.y, m: next.m, d: nd,
      current: false,
      today: next.y === today.y && next.m === today.m && nd === today.d,
      selected: !!sel && sel.y === next.y && sel.m === next.m && sel.d === nd,
    });
    nd += 1;
  }

  const titleId = id ? `${id}-cal-title` : undefined;

  return (
    <span className="kf-pe-date">
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className="kf-pe-select__btn"
        aria-haspopup="dialog"
        aria-expanded={open ? "true" : "false"}
        aria-describedby={hintId}
        aria-invalid={errorId ? "true" : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <Calendar size={16} strokeWidth={1.5} aria-hidden />
        <span className="kf-pe-select__val">{displayValue || <span className="kf-pe-muted">{placeholder}</span>}</span>
      </button>
      {open ? (
        <div
          ref={popRef}
          className="kf-pe-cal"
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
        >
          <div className="kf-pe-cal__head">
            <button
              type="button"
              className="kf-pe-iconbtn"
              aria-label="Previous month"
              onClick={() => setCursor(shiftMonths(cursor, -1))}
            >
              <ChevronLeft size={18} strokeWidth={1.5} aria-hidden />
            </button>
            <b id={titleId}>{MONTHS_FULL[cursor.m - 1]} {cursor.y}</b>
            <button
              type="button"
              className="kf-pe-iconbtn"
              aria-label="Next month"
              onClick={() => setCursor(shiftMonths(cursor, 1))}
            >
              <ChevronRight size={18} strokeWidth={1.5} aria-hidden />
            </button>
          </div>
          <div className="kf-pe-cal__dow" aria-hidden>
            {DOW_SHORT.map((d) => <span key={d}>{d}</span>)}
          </div>
          <div
            className="kf-pe-cal__grid"
            role="grid"
            aria-labelledby={titleId}
            onKeyDown={onGridKey}
          >
            {grid.map((cell, i) => (
              <button
                key={`${cell.y}-${cell.m}-${cell.d}-${i}`}
                type="button"
                className={[
                  "kf-pe-cal__day",
                  cell.current ? "" : "is-dim",
                  cell.today ? "is-today" : "",
                  cell.selected ? "is-selected" : "",
                ].filter(Boolean).join(" ")}
                data-day={cell.d}
                data-current={cell.current ? "true" : "false"}
                aria-selected={cell.selected ? "true" : undefined}
                aria-current={cell.today ? "date" : undefined}
                tabIndex={cell.current && cell.d === cursor.d ? 0 : -1}
                onClick={() => {
                  onChange(toYMD(cell.y, cell.m, cell.d));
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
              >
                {cell.d}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </span>
  );
}
