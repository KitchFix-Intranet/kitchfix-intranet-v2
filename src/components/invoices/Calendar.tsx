"use client";

// Lane-local calendar picker. A month grid: 48 px day cells,
// previous / next month, today marked, future dates blocked.
// Pure UI - the parent passes the current ISO (or null) and a
// setter. Escape closes via the Sheet wrapper.
//
// On desk the parent renders the Calendar inside a positioned
// popover; on phone the parent wraps it in <Sheet>. Either way,
// it's the same component.

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { parseDateInput } from "@/lib/invoices/dateInput";

interface Props {
  // The currently picked ISO date-only ("YYYY-MM-DD"), or null.
  selectedIso: string | null;
  // Called with an ISO date-only or null.
  onPick: (iso: string) => void;
  // Called when the user presses Escape or the X. Optional for
  // callers that handle close via the enclosing Sheet.
  onClose?: () => void;
}

const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const FULL_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function pad2(n: number): string { return n < 10 ? `0${n}` : String(n); }

function todayParts(): { y: number; m: number; d: number } {
  // Chicago-safe: use parseDateInput's view of today via a freshly
  // built string from the browser's local date. Train 2b: tests fix
  // today per-test; here we trust the browser clock.
  const now = new Date();
  // Reuse parseDateInput by formatting MM/DD/YYYY from local parts.
  // Keeps one source of truth for "today".
  const s = `${pad2(now.getMonth() + 1)}/${pad2(now.getDate())}/${now.getFullYear()}`;
  const r = parseDateInput(s, now);
  if (!r.iso) {
    return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
  }
  return { y: Number(r.iso.slice(0, 4)), m: Number(r.iso.slice(5, 7)), d: Number(r.iso.slice(8, 10)) };
}

export function Calendar({ selectedIso, onPick, onClose }: Props) {
  const today = useMemo(todayParts, []);
  const initial = useMemo(() => {
    if (selectedIso && /^\d{4}-\d{2}-\d{2}$/.test(selectedIso)) {
      return { y: Number(selectedIso.slice(0, 4)), m: Number(selectedIso.slice(5, 7)) };
    }
    return { y: today.y, m: today.m };
  }, [selectedIso, today]);

  const [{ y, m }, setCursor] = useState(initial);

  const first = new Date(y, m - 1, 1).getDay();
  const daysInMonth = new Date(y, m, 0).getDate();

  const todayIndex = today.y * 10000 + today.m * 100 + today.d;
  const nextMonthStarts = y * 10000 + (m + 1) * 100 + 1;
  const canGoForward = nextMonthStarts <= todayIndex;

  const nav = (dir: -1 | 1) => {
    const d = new Date(y, m - 1 + dir, 1);
    setCursor({ y: d.getFullYear(), m: d.getMonth() + 1 });
  };

  const cells: React.ReactNode[] = [];
  for (let i = 0; i < first; i++) cells.push(<span key={`b${i}`} aria-hidden />);
  for (let k = 1; k <= daysInMonth; k++) {
    const iso = `${y}-${pad2(m)}-${pad2(k)}`;
    const dateIdx = y * 10000 + m * 100 + k;
    const future = dateIdx > todayIndex;
    const picked = selectedIso === iso;
    const isToday = dateIdx === todayIndex;
    if (future) {
      cells.push(
        <span
          key={iso}
          className="kf-inv-cal__off"
          aria-disabled="true"
          aria-label={`${FULL_MONTHS[m - 1]} ${k} ${y}, in the future`}
        >
          {k}
        </span>,
      );
    } else {
      cells.push(
        <button
          key={iso}
          type="button"
          className="kf-inv-cal__day"
          aria-pressed={picked ? true : undefined}
          aria-current={isToday ? "date" : undefined}
          onClick={() => onPick(iso)}
        >
          {k}
        </button>,
      );
    }
  }

  return (
    <div
      className="kf-inv-cal"
      role="group"
      aria-label="Pick the invoice date"
      onKeyDown={(e) => { if (e.key === "Escape") onClose?.(); }}
    >
      <div className="kf-inv-cal__head">
        <button
          type="button"
          className="kf-inv-cal__nav"
          aria-label="Earlier month"
          onClick={() => nav(-1)}
        >
          <ChevronLeft size={18} strokeWidth={1.75} aria-hidden />
        </button>
        <strong>{FULL_MONTHS[m - 1]} {y}</strong>
        <button
          type="button"
          className="kf-inv-cal__nav"
          aria-label="Later month"
          onClick={() => nav(1)}
          disabled={!canGoForward}
        >
          <ChevronRight size={18} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      <div className="kf-inv-cal__grid kf-inv-cal__dow" aria-hidden>
        {DOW.map((d) => <span key={d}>{d}</span>)}
      </div>
      <div className="kf-inv-cal__grid">
        {cells}
      </div>
    </div>
  );
}
