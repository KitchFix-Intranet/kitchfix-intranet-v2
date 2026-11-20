// Train 6 carry-in: compose the FinishOverlay's screen-reader line
// in plain words, in the site's timezone.
//
// Chat ruling 2026-11-20:
//   Weekly:  "Submitted Monday, Nov 23 at 9:35 AM. Week of Nov 16 - Nov 22."
//   Biweekly: "Submitted Monday, Nov 23 at 7:35 AM. Two weeks of Nov 9 - Nov 22."
// No year, no zone letters, no "Unit span".
//
// Pure. Takes the ISO timestamp + the two ISO dates + the site tz
// + whether the unit is a pair. No HTML, no DOM.

export interface FinishOverlaySrInput {
  submittedAtIso: string;      // ISO-8601 instant.
  unitStartIso: string;        // YYYY-MM-DD.
  unitEndIso: string;          // YYYY-MM-DD.
  timeZone: string;            // e.g. "America/Chicago"
  isPair: boolean;             // true for biweekly closing-week submits
}

export function finishOverlaySr(input: FinishOverlaySrInput): string {
  const submitted = formatSubmittedAt(input.submittedAtIso, input.timeZone);
  const start = formatDateMonthDay(input.unitStartIso, input.timeZone);
  const end = formatDateMonthDay(input.unitEndIso, input.timeZone);
  const prefix = input.isPair ? "Two weeks of" : "Week of";
  return `Submitted ${submitted}. ${prefix} ${start} - ${end}.`;
}

function formatSubmittedAt(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  try {
    const date = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
      month: "short",
      day: "numeric",
    }).format(d);
    const time = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(d);
    return `${date} at ${time}`;
  } catch {
    return iso;
  }
}

function formatDateMonthDay(iso: string, timeZone: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  // Anchor at local noon so the zone rendering lands on the correct
  // calendar day regardless of DST.
  const d = new Date(`${iso}T12:00:00Z`);
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "short",
      day: "numeric",
    }).format(d);
  } catch {
    return iso;
  }
}
