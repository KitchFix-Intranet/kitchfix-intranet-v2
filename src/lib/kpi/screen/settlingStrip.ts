// src/lib/kpi/screen/settlingStrip.ts
//
// Train 2d-1. v1 component:
// src/app/kpi/overview/components/SettlingStrip.js (57 lines).
//
// Fires on Last period when the period is closed but not yet
// finance-verified. Carries two kinds of still-moving info:
//
//   - purchases line (always renders when settling is present)
//   - labour line (renders only when labour.hours > 0.04 AND
//     labour.people > 0)
//
// Payload contract (unchanged from v1 doc comment):
//   settling: {
//     period_no, period_end,
//     labour: { hours, people },
//   } | null
//
// Model vocabulary:
//   render   - true iff v1 would render the strip (settling != null)
//   period_no - integer
//   purchases - { period_no } - always present when render is true
//   labour    - { hours, people } | null (null when the labour line
//               is dropped per v1's threshold)
//
// No clock read, no DOM read; a plain reshape of the payload.

import { formatHoursTwoDecimals, formatPersonCount } from "./formatting";

export type SettlingStripModel = {
  render: boolean;
  period_no: number | null;
  purchases: { period_no: number } | null;
  labour: { hours: number; people: number } | null;
};

export function buildSettlingStrip(payload: any): SettlingStripModel {
  const s = payload?.settling ?? null;
  if (!s) {
    return { render: false, period_no: null, purchases: null, labour: null };
  }
  const pn = s.period_no != null ? Number(s.period_no) : null;
  const l = s.labour ?? null;
  const hours = l ? Number(l.hours || 0) : 0;
  const people = l ? Number(l.people || 0) : 0;
  const hasLabour = l != null && hours > 0.04 && people > 0;
  return {
    render: true,
    period_no: pn,
    purchases: pn != null ? { period_no: pn } : null,
    labour: hasLabour ? { hours, people } : null,
  };
}

// --- Formatter (screen-time copy) ---------------------------------

export type SettlingStripDisplay = {
  render: boolean;
  title: string | null;
  purchases_line: string | null;
  labour_line: string | null;
};

export function formatSettlingStrip(
  m: SettlingStripModel,
): SettlingStripDisplay {
  if (!m.render || m.period_no == null) {
    return {
      render: false,
      title: null,
      purchases_line: null,
      labour_line: null,
    };
  }
  const title = "What is still moving";
  const purchases_line =
    `Invoices for P${m.period_no} finalizing, Invoices and Credit Card charges land on the nightly sync.`;
  let labour_line: string | null = null;
  if (m.labour) {
    const hrs = formatHoursTwoDecimals(m.labour.hours);
    const people = formatPersonCount(m.labour.people);
    if (hrs != null && people != null) {
      labour_line = `${hrs} hrs awaiting approval across ${people} · lands as they are approved`;
    }
  }
  return { render: true, title, purchases_line, labour_line };
}
