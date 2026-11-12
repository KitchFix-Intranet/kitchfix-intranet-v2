// T3.1 fix 7 (2026-11-13). Separation "Type" is Voluntary or
// Involuntary, derived from the SEPARATION REASON. T3 wrongly read
// `statusChangeDirection`, which is the Part-time / Full-time
// toggle for a status change, not a separation signal.
//
// Buckets confirmed from the DB probe over the current 75
// separation rows (case-insensitive match):
//   Voluntary   : Resignation, Job Abandonment.
//   Involuntary : Termination, Layoff, Furlough, End of Season.
//   Anything else (blank, unexpected): "Not given".

export function separationType(reason: string | null | undefined): string {
  const r = String(reason ?? "").trim().toLowerCase();
  if (r === "resignation" || r === "job abandonment") return "Voluntary";
  if (r === "termination" || r === "layoff" || r === "furlough" || r === "end of season") return "Involuntary";
  return "Not given";
}
