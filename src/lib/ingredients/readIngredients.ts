// The one reader for a full list of active ingredients. Every call
// that today runs `.from("pr_ingredients").select(...).eq("status",
// "active")...` without `.range()` reaches silently into PostgREST's
// 1,000-row cap once the masters list grows past 1,000 (train 1's
// standing caution). This reader does three things:
//
//   1. Reads the total it should return with `count: "exact", head:
//      true` on the same filter, before paging.
//   2. Pages explicitly in 1,000-row windows until a page returns
//      fewer than the window.
//   3. Fails loudly (throws) when the paged count does not match the
//      count-exact total - a dropped page must never read as a short
//      list.
//
// Callers choose the projection (columns) so the two small reads -
// the distinct-parent read in /api/review/item and the one-column
// `select("parent")` the sub-category dropdown uses - stay tiny.
//
// The client parameter is typed as `MinimalSupabase` so the proof
// script in /scripts/t2_reader_proof.mjs can stand in a fake that
// matches the shape used here, without a real supabase import.

export type MinimalSupabaseFilter = {
  select: (cols: string, opts?: { count?: "exact"; head?: true }) => MinimalSupabaseFilter;
  eq: (col: string, value: unknown) => MinimalSupabaseFilter;
  neq: (col: string, value: unknown) => MinimalSupabaseFilter;
  is: (col: string, value: unknown) => MinimalSupabaseFilter;
  not: (col: string, op: string, value: unknown) => MinimalSupabaseFilter;
  in: (col: string, values: unknown[]) => MinimalSupabaseFilter;
  order: (col: string, opts?: { ascending?: boolean }) => MinimalSupabaseFilter;
  range: (from: number, to: number) => MinimalSupabaseFilter;
  then: <T>(
    onfulfilled: (value: { data: unknown; error: { message: string } | null; count?: number | null }) => T | PromiseLike<T>
  ) => Promise<T>;
};

export type MinimalSupabase = {
  from: (table: string) => MinimalSupabaseFilter;
};

const PAGE = 1000;

export type ReadActiveIngredientsOptions = {
  // Column projection. Caller decides. Example: "id,name" or
  // "id,name,parent,category,resale,base_unit".
  columns: string;
  // Additional equality filters on top of `status="active"`. Useful
  // for the Ingredients / Retail split which filters on `resale`.
  equals?: Array<[string, unknown]>;
  // Additional `.not(col, op, value)` filters. The distinct-parent
  // read uses `.not("parent", "is", null)`.
  nots?: Array<[string, string, unknown]>;
  // Order column. Defaults to "name".
  orderBy?: string;
};

export class IngredientListShortError extends Error {
  expected: number;
  got: number;
  constructor(expected: number, got: number) {
    super(
      `Ingredient list came back short: expected ${expected} rows, got ${got}. Not using a partial list.`
    );
    this.name = "IngredientListShortError";
    this.expected = expected;
    this.got = got;
  }
}

export async function readActiveIngredients<T = Record<string, unknown>>(
  client: MinimalSupabase,
  opts: ReadActiveIngredientsOptions
): Promise<T[]> {
  const { columns, equals = [], nots = [], orderBy = "name" } = opts;

  const applyFilters = (q: MinimalSupabaseFilter): MinimalSupabaseFilter => {
    let qq = q.eq("status", "active");
    for (const [col, val] of equals) qq = qq.eq(col, val);
    for (const [col, op, val] of nots) qq = qq.not(col, op, val);
    return qq;
  };

  // 1. The expected total. count: exact + head: true never returns
  //    rows and never hits the cap.
  const countRes = await applyFilters(
    client.from("pr_ingredients").select(columns, { count: "exact", head: true })
  );
  if (countRes.error) throw new Error(countRes.error.message);
  const expected = countRes.count ?? 0;

  // 2. Page through, stop when the latest page was smaller than PAGE.
  //    T2 round 2 §5: order by `id` as a tiebreak after `orderBy`.
  //    If two rows share the first order column PostgREST's own
  //    ordering is undefined: a page boundary can repeat one row and
  //    skip another while the total still matches the count, and the
  //    length check below would pass on a wrong list.
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const pageRes = await applyFilters(
      client.from("pr_ingredients").select(columns).order(orderBy).order("id")
    ).range(from, from + PAGE - 1);
    if (pageRes.error) throw new Error(pageRes.error.message);
    const chunk = (pageRes.data ?? []) as T[];
    out.push(...chunk);
    if (chunk.length < PAGE) break;
    from += PAGE;
  }

  // 3. Fail loudly if the paged total did not match the count. A
  //    dropped page must read as an error, never as a short list.
  if (out.length !== expected) {
    throw new IngredientListShortError(expected, out.length);
  }
  return out;
}
