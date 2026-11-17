// LIKE-safe escaping for ilike filters.
//
// PostgREST's ilike treats `%`, `_` and `\` as metacharacters. An
// unescaped user string containing any of those either widens the
// match or injects behaviour the user did not type. We escape them
// with the default backslash before passing the string to supabase-js.
//
// For the search filter the invoices lane never calls .or() (its
// grammar is unsafe for arbitrary user text - commas, parens, dots
// and quotes are structural). The scope.ts "two scoped queries +
// merge" rule in load.ts uses this helper once per column.

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
