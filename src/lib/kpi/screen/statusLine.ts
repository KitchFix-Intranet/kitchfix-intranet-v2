// src/lib/kpi/screen/statusLine.ts
//
// Train 2d-1. v1 component: src/app/kpi/overview/components/StatusLine.js
// (83 lines). Closed-range Overview surfaces two possible pills + a
// horizon line:
//
//   - a status pill (state_copy + tone), always present when
//     payload.status_line.state is set
//   - an "awaiting verification" pill (only on This year when R-93
//     has excluded the just-closed period; built in page.js and
//     passed as `awaiting`)
//   - a horizon caption from range_labels.horizon
//
// The component does no clock reads. The `awaiting` object is
// computed in page.js by calling v1's periods helpers (r93Excluded
// PeriodNo + periodEndISO) which take `today` as an input; that
// pre-model computation is part of the closed-range screen math and
// lives here as a plain function that takes the same facts.
//
// Model vocabulary:
//   state - the state string shipped on payload.status_line.state
//   tone  - "good" | "bad" | "neutral" | "wait" | "run"  (v1 TONE_CLASS)
//   leading_dot - true when tone is wait or run (v1 showLeadingDot)
//   awaiting - { period_no, close_iso, settle_iso } | null
//   horizon - string | null
//
// Running/planned ranges are 2d-2; on those ranges `tone` can be
// "run" / "wait", and this builder still carries them through so the
// data shape is stable across trains.

export type StatusTone = "good" | "bad" | "neutral" | "wait" | "run";

export type StatusLineAwaiting = {
  period_no: number;
  close_iso: string;
  settle_iso: string;
};

export type StatusLineModel = {
  state: string | null;
  tone: StatusTone | null;
  state_copy: string | null;
  leading_dot: boolean;
  awaiting: StatusLineAwaiting | null;
  horizon: string | null;
};

const TONES: Record<string, StatusTone> = {
  good: "good",
  bad: "bad",
  neutral: "neutral",
  wait: "wait",
  run: "run",
};

function normalizeTone(t: any): StatusTone | null {
  if (t == null) return null;
  const s = String(t);
  return (TONES[s] as StatusTone) ?? null;
}

/**
 * Build the StatusLine screen model from the payload + the
 * already-computed `awaiting` object (page.js owns this).
 *
 * Caller contract: pass the exact shape the v1 page renders -
 * `payload.status_line`, `payload.range_labels`, and whatever
 * `awaiting` was computed by buildAwaiting below. All inputs may be
 * null; the model's slots are null when absent.
 */
export function buildStatusLine(
  payload: any,
  awaiting: StatusLineAwaiting | null,
): StatusLineModel {
  const sl = payload?.status_line ?? null;
  const rl = payload?.range_labels ?? null;
  const tone = normalizeTone(sl?.tone);
  const state = sl?.state ?? null;
  const state_copy = sl?.state_copy ?? null;
  const horizon = rl?.horizon ?? null;
  const leading_dot = tone === "wait" || tone === "run";
  return {
    state,
    tone,
    state_copy,
    leading_dot,
    awaiting: awaiting ?? null,
    horizon,
  };
}

/**
 * v1 page.js:787-814 inline. Compute the FYTD awaiting-verification
 * pill payload.
 *
 * Inputs:
 *   resolvedPreset - "fytd" | "this_period" | "last_period" | null
 *   excludedPeriodNo - r93ExcludedPeriodNo(today); null when no such
 *     period exists (today falls inside the 8-day post-close settle
 *     window of some period).
 *   periodEndIso - periodEndISO(excludedPeriodNo). Caller already
 *     resolved it; passed in to keep this function clock-free.
 *
 * Returns the { period_no, close_iso, settle_iso } object or null.
 * settle_iso is close + 8 days (UTC arithmetic, mirrors v1's inline
 * Date + 8 * 86400000 compute).
 */
export function buildAwaiting(
  resolvedPreset: string | null,
  excludedPeriodNo: number | null | undefined,
  periodEndIso: string | null | undefined,
): StatusLineAwaiting | null {
  if (resolvedPreset !== "fytd") return null;
  if (excludedPeriodNo == null) return null;
  if (!periodEndIso) return null;
  const t = Date.UTC(
    Number(periodEndIso.slice(0, 4)),
    Number(periodEndIso.slice(5, 7)) - 1,
    Number(periodEndIso.slice(8, 10)),
  );
  if (Number.isNaN(t)) return null;
  const settleMs = t + 8 * 86400000;
  const d = new Date(settleMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return {
    period_no: Number(excludedPeriodNo),
    close_iso: String(periodEndIso),
    settle_iso: `${y}-${m}-${dd}`,
  };
}

// --- Formatter (screen-time copy) ---------------------------------
//
// v1 StatusLine renders an awaiting pill with the sentence:
//   `P${period_no} awaiting verification · closes ${mo}/${da}`
// (mo + da are NUMBER-coerced, so single-digit months render without
// a leading zero.) The formatter composes that string from the data
// model. The main status pill's text is `state_copy`, which the
// resolver already composed - the formatter passes it through.

export type StatusLineDisplay = {
  state: string | null;
  tone: StatusTone | null;
  state_copy: string | null;
  leading_dot: boolean;
  awaiting_copy: string | null;
  horizon: string | null;
};

export function formatStatusLine(m: StatusLineModel): StatusLineDisplay {
  let awaiting_copy: string | null = null;
  if (m.awaiting?.period_no != null && m.awaiting?.settle_iso) {
    const parts = m.awaiting.settle_iso.split("-");
    const mo = parts[1] ? Number(parts[1]) : null;
    const da = parts[2] ? Number(parts[2]) : null;
    if (mo != null && da != null) {
      awaiting_copy = `P${m.awaiting.period_no} awaiting verification · closes ${mo}/${da}`;
    }
  }
  return {
    state: m.state,
    tone: m.tone,
    state_copy: m.state_copy,
    leading_dot: m.leading_dot,
    awaiting_copy,
    horizon: m.horizon,
  };
}
