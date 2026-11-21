// src/lib/kpi/screen/weekFlag.ts
//
// Train 2d-1. MOVE WHOLE from v1:
//   src/app/kpi/labor/lib/weekFlag.js (91 lines).
//
// Pure model function for the WeekTable's per-week exception chip
// (aka "V42 state"). Inputs: week row + isClosed; outputs: null OR
// a descriptor { state, label, cls, tooltip, glyph }.

export type WeekFlag = {
  state: "s1" | "s2" | "s3a" | "s3b";
  label: string;
  cls: string;
  tooltip: string;
  glyph: string | null;
} | null;

export function flagForV42State(w: any, isClosed: any): WeekFlag {
  const nc = Number(w?.anomaly_no_clockout || 0);
  const u1 = Number(w?.anomaly_under_1h || 0);
  const o16 = Number(w?.anomaly_over_16h || 0);
  const anomalies = nc + u1 + o16;
  const unpriced = Number(
    w?.unpriced_hrs ?? w?.hours_without_dollars ?? 0,
  );
  const drafts = Number(w?.draft_entry_count || 0);
  const draftHrs = Number(w?.draft_hours || 0);
  if (anomalies > 0) {
    const detail: string[] = [];
    if (nc > 0) detail.push(`${nc} never clocked out`);
    if (u1 > 0) detail.push(`${u1} under 1h`);
    if (o16 > 0) detail.push(`${o16} over 16h`);
    return {
      state: "s2",
      label: `${anomalies} need${anomalies === 1 ? "s" : ""} attention`,
      cls: "kpi-flag-warn",
      tooltip: `These time entries can't be approved as-is - a human has to fix them in Rippling. ${detail.join(", ")}.`,
      glyph: "⚠",
    };
  }
  if (isClosed && unpriced > 0.004) {
    return {
      state: "s3b",
      label: `closed week understated - ${unpriced.toFixed(1)} hrs missing pay data`,
      cls: "kpi-flag-bad",
      tooltip:
        "This closed week's dollar total is incomplete. Pay-segments for the missing hours have not landed yet.",
      glyph: "⚠",
    };
  }
  if (isClosed && drafts > 0) {
    return {
      state: "s3a",
      label: `closed week awaiting approval${draftHrs > 0.004 ? ` - ${draftHrs.toFixed(1)} hrs` : ""}`,
      cls: "kpi-flag-warn kpi-flag-warn-soft",
      tooltip:
        "Dollars for this week are complete. The entries have not been formally approved in Rippling.",
      glyph: "⚠",
    };
  }
  if (!isClosed && drafts > 0) {
    return {
      state: "s1",
      label: `${draftHrs > 0.004 ? draftHrs.toFixed(1) : drafts} hrs pending approval`,
      cls: "kpi-flag-mute",
      tooltip:
        "Time entries clocked but not yet approved in Rippling. Approving them will not change the dollar total.",
      glyph: null,
    };
  }
  return null;
}
