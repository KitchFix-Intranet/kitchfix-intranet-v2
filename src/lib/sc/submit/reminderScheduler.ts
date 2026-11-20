// Train 6: pure schedulers for the two reminders. The cron fires in
// UTC on a Friday + Monday window; these functions decide "is it the
// right local hour for this site, right now" so the handler can skip
// the off-hour ticks without any assumption about CST / CDT / EST /
// EDT / MST. Everything flows through `Intl.DateTimeFormat` - no
// hand-coded DST table.

const DOW_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  weekday: string;
}

// Read year/month/day/hour/weekday in a given zone. Never throws;
// returns null if the zone is not in the tzdb (treated as a server
// bug, the caller refuses).
export function localPartsInZone(now: Date, timeZone: string): LocalParts | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
      weekday: "long",
    }).formatToParts(now);
    const map = new Map<string, string>();
    for (const p of parts) map.set(p.type, p.value);
    const year = Number(map.get("year"));
    const month = Number(map.get("month"));
    const day = Number(map.get("day"));
    let hour = Number(map.get("hour"));
    // Some locales render "24" at midnight; normalise to 0.
    if (hour === 24) hour = 0;
    const weekday = String(map.get("weekday") ?? "");
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day) || !Number.isFinite(hour)) {
      return null;
    }
    return { year, month, day, hour, weekday };
  } catch {
    return null;
  }
}

// Monday of the local date, as an ISO date (YYYY-MM-DD).
export function mondayOfLocalDate(parts: LocalParts): string {
  // Build a stable Date for the local midnight of this date in UTC
  // terms - we only need its day-of-week.
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const jsDow = d.getUTCDay(); // 0 = Sunday .. 6 = Saturday
  const back = (jsDow + 6) % 7;  // 0 if Monday, 1 if Tuesday ...
  d.setUTCDate(d.getUTCDate() - back);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

// Monday of the week BEFORE the one containing this date.
export function mondayOfPreviousWeek(parts: LocalParts): string {
  const thisMon = mondayOfLocalDate(parts);
  const d = new Date(`${thisMon}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 7);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

// "Right now in <zone> is Friday 15:00." Pure.
export function isFridayCentralHour(now: Date): boolean {
  const p = localPartsInZone(now, "America/Chicago");
  if (!p) return false;
  return p.weekday === "Friday" && p.hour === 15;
}

// "Right now in <timeZone> is Monday 09:00." Pure.
export function isMondayNineAtTz(now: Date, timeZone: string): boolean {
  const p = localPartsInZone(now, timeZone);
  if (!p) return false;
  return p.weekday === "Monday" && p.hour === 9;
}

// Add N days to an ISO date (YYYY-MM-DD). Pure. Train 1b helper lives
// in calendar/periodWindow.ts; this file is lane-local-small so we
// inline a private copy to keep the reminder lane importable without
// the calendar module.
export function addDaysIso(iso: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`addDaysIso: ${iso}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + days);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${dd}`;
}

// The week a reminder is about:
//   Friday  -> the unit that CONTAINS this Friday.
//   Monday  -> the unit that ENDED YESTERDAY.
// Returns the Monday that the submit record would carry - for a
// biweekly account, that is the pair's CLOSING Monday.
export function reminderWeekStartFriday(now: Date, tz: string): string | null {
  const p = localPartsInZone(now, tz);
  if (!p) return null;
  return mondayOfLocalDate(p);
}
export function reminderWeekStartMonday(now: Date, tz: string): string | null {
  // Local "today" is Monday; the unit that ended yesterday started
  // last Monday.
  const p = localPartsInZone(now, tz);
  if (!p) return null;
  return mondayOfPreviousWeek(p);
}

export { DOW_LONG };
