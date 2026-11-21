// src/lib/kpi/screen/overdueNudge.ts
//
// Train 2d-1. v1 component:
// src/app/kpi/overview/components/OverdueNudge.js (32 lines).
//
// Sibling of SettlingStrip. Fires AFTER the R-93 settle boundary
// while Finance still hasn't posted the P&L. One turns off exactly
// when the other turns on.
//
// Payload contract:
//   overdue_periods: [{ period_no, period_end_iso, days_since_close }]
// Empty / missing -> nothing renders.
//
// Model vocabulary:
//   render   - true iff v1 would render at least one entry
//   entries  - [{ period_no, days_since_close }] (period_end_iso is
//              not on the render; kept out of the model)
//
// Kevin ruling 2026-11-20: no live case reaches this today under the
// current data; the per-period entry still models cleanly.

import { formatDaysCount } from "./formatting";

export type OverdueNudgeEntry = {
  period_no: number;
  days_since_close: number;
};

export type OverdueNudgeModel = {
  render: boolean;
  entries: OverdueNudgeEntry[];
};

export function buildOverdueNudge(payload: any): OverdueNudgeModel {
  const list = Array.isArray(payload?.overdue_periods)
    ? payload.overdue_periods
    : [];
  const entries: OverdueNudgeEntry[] = [];
  for (const p of list) {
    if (p == null) continue;
    const pn = p.period_no != null ? Number(p.period_no) : null;
    const dsc = p.days_since_close != null ? Number(p.days_since_close) : null;
    if (pn == null || dsc == null) continue;
    entries.push({ period_no: pn, days_since_close: dsc });
  }
  return { render: entries.length > 0, entries };
}

// --- Formatter ----------------------------------------------------

export type OverdueNudgeDisplay = {
  render: boolean;
  lines: string[];
};

export function formatOverdueNudge(m: OverdueNudgeModel): OverdueNudgeDisplay {
  if (!m.render) return { render: false, lines: [] };
  const lines = m.entries.map((e) => {
    const days = formatDaysCount(e.days_since_close);
    return `P${e.period_no} closed ${days} ago · no finance P&L loaded`;
  });
  return { render: true, lines };
}
