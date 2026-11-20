// src/lib/kpi/shared/pagedSelect.ts
//
// Train 2b. One paging helper for every read under src/lib/kpi/**.
//
// The caller passes a `build(from, to)` that returns the completed
// PostgREST builder (already chained with .select / .in / .gte / .lte
// / .order / .range). The helper calls it, concatenates rows, and
// repeats on the next page until a short page comes back.
//
// Every paged read MUST sort on a unique key. There is no silent
// fallback: if the sort column is not unique within the filter's row
// set, pages can drop or duplicate rows at the 1,000-row boundary.
// The audit in docs/KPI.md names each caller and the key that makes
// its sort unique.
//
// Exempt from this helper: `.single()` / `.maybeSingle()` (one row by
// definition), and reads bounded by a caller-chunked id list where
// every chunk is small enough that the row count can never exceed
// the page cap (purchasing/loaders' billcom_ref_vendors, spend_
// category_map, spend_work_location_site_map; these call
// `.in("id", idChunk)` with no `.range` and no paging - see the
// audit table for the list).

const DEFAULT_PAGE = 1000;

export type PageBuilder = (from: number, to: number) => any;

// Paginate until a short page. Returns { data, error }. The caller
// builds the query each iteration with its own .select / .order /
// .filter chain; the helper only varies the .range window. Errors
// surface in the same shape PostgREST returns.
export async function pagedSelect(
  build: PageBuilder,
  { pageSize = DEFAULT_PAGE }: { pageSize?: number } = {},
): Promise<{ data: any[]; error?: any }> {
  const out: any[] = [];
  let from = 0;
  while (true) {
    const q = await build(from, from + pageSize - 1);
    if (q.error) return { data: out, error: q.error };
    const rows = q.data || [];
    for (const r of rows) out.push(r);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return { data: out };
}
