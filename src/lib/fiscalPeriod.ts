// Looks up the current fiscal period from the fiscal_periods table and
// memoizes the result by Chicago date string. One row per day; a 52-row
// indexed read per uncached request is fine. Keeping this out of any Next
// cache primitive on purpose: `"use cache"` needs cacheComponents (changes
// the whole app's rendering model) and `unstable_cache` is legacy. A plain
// module-level Map inside the server bundle is the cheapest option.

import { serviceClient } from "./supabase/service";
import { TZ } from "./fmt";

type Period = { period_no: number; week: number };

const cache = new Map<string, Period | null>();

function chicagoDate(): string {
  const d = new Date();
  const bits = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(d)
    .reduce<Record<string, string>>((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});
  return `${bits.year}-${bits.month}-${bits.day}`;
}

export async function currentPeriod(): Promise<Period | null> {
  const key = chicagoDate();
  if (cache.has(key)) return cache.get(key) ?? null;
  try {
    const client = serviceClient();
    const { data } = await client
      .from("fiscal_periods")
      .select("period_no,start_date")
      .lte("start_date", key)
      .gte("end_date", key)
      .limit(1)
      .maybeSingle();
    if (!data) {
      cache.set(key, null);
      return null;
    }
    const row = data as { period_no: number; start_date: string };
    const startMs = Date.parse(row.start_date);
    const todayMs = Date.parse(key);
    const week = Math.floor((todayMs - startMs) / (7 * 24 * 60 * 60 * 1000)) + 1;
    const p: Period = { period_no: row.period_no, week };
    cache.set(key, p);
    return p;
  } catch {
    return null;
  }
}
