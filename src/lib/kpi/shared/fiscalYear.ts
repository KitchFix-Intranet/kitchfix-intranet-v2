// src/lib/kpi/shared/fiscalYear.ts
//
// Train 2b. The fiscal year arrives from the caller. No file under
// src/lib/kpi/** (outside tests and proof/) holds a fiscal year or a
// fiscal year's first or last day. Period arithmetic reads the object
// below rather than re-deriving dates by adding 28 days to a typed-in
// start.
//
// The object has 13 periods, each 28 days, back-to-back. loadFiscalYear
// refuses to return anything else: a year with 12 or 14 rows, a period
// that is not 28 days, or a gap or overlap between adjacent periods
// throws from the loader. The engine never catches that throw: a bad
// year is a configuration bug, not a data case.

export type FiscalYearPeriod = {
  period_no: number;   // 1..13
  startISO: string;    // YYYY-MM-DD, inclusive
  endISO: string;      // YYYY-MM-DD, inclusive
};

export type FiscalYear = {
  year: number;
  periods: FiscalYearPeriod[];   // length 13, strictly in order
  startISO: string;              // === periods[0].startISO
  endISO: string;                // === periods[12].endISO
};

const MS_PER_DAY = 86400000;

function parseISOUTC(iso: string): Date | null {
  if (typeof iso !== "string") return null;
  const m = iso.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

// Validate + build. Throws on any shape violation.
export function buildFiscalYear(year: number, rows: Array<{ period_no: number; start_date: string; end_date: string }>): FiscalYear {
  if (!Number.isInteger(year)) {
    throw new Error(`loadFiscalYear: year must be an integer, got ${year}`);
  }
  if (!Array.isArray(rows) || rows.length !== 13) {
    throw new Error(`loadFiscalYear: fiscal_periods for ${year} must have exactly 13 rows, found ${rows?.length ?? 0}`);
  }
  const periods: FiscalYearPeriod[] = [];
  for (let i = 0; i < 13; i += 1) {
    const r = rows[i];
    if (!r || r.period_no !== i + 1) {
      throw new Error(`loadFiscalYear: fiscal_periods for ${year} out of sequence at index ${i} (period_no=${r?.period_no})`);
    }
    const start = parseISOUTC(r.start_date);
    const end = parseISOUTC(r.end_date);
    if (!start || !end) {
      throw new Error(`loadFiscalYear: fiscal_periods for ${year} P${r.period_no} has unparseable dates`);
    }
    const dayCount = Math.round((end.getTime() - start.getTime()) / MS_PER_DAY) + 1;
    if (dayCount !== 28) {
      throw new Error(`loadFiscalYear: fiscal_periods for ${year} P${r.period_no} is ${dayCount} days, expected 28`);
    }
    if (i > 0) {
      const prevEnd = parseISOUTC(rows[i - 1].end_date);
      if (!prevEnd) {
        throw new Error(`loadFiscalYear: fiscal_periods for ${year} P${rows[i - 1].period_no} has unparseable end_date`);
      }
      const gapDays = Math.round((start.getTime() - prevEnd.getTime()) / MS_PER_DAY);
      if (gapDays !== 1) {
        throw new Error(`loadFiscalYear: fiscal_periods for ${year} P${r.period_no} not back-to-back with P${rows[i - 1].period_no} (gap=${gapDays}d)`);
      }
    }
    periods.push({
      period_no: r.period_no,
      startISO: r.start_date.slice(0, 10),
      endISO: r.end_date.slice(0, 10),
    });
  }
  return {
    year,
    periods,
    startISO: periods[0].startISO,
    endISO: periods[12].endISO,
  };
}

// Reads one year from fiscal_periods and returns plain data.
export async function loadFiscalYear(supa: any, year: number): Promise<FiscalYear> {
  const { data, error } = await supa
    .from("fiscal_periods")
    .select("fiscal_year, period_no, start_date, end_date")
    .eq("fiscal_year", year)
    .order("period_no", { ascending: true });
  if (error) throw error;
  return buildFiscalYear(year, (data || []) as Array<{ period_no: number; start_date: string; end_date: string }>);
}
