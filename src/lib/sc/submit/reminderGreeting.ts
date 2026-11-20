// Train 6: the first-line greeting rule, Kevin ruling 2026-11-20.
//
//   0 names found  ->  "Hi,"
//   1..3 names     ->  "Hi A,"; "Hi A and B,"; "Hi A, B and C,"
//   >3 names       ->  "Hi all,"
//
// Names come from `people.display_name`; the first token (first run
// of non-whitespace) is the first name. The caller passes the full
// display_name list; this function orders them as given and never
// invents a name. An empty display_name is dropped.
//
// Pure. No escaping (the render functions escape every substitution
// before inserting into HTML).

export function reminderGreeting(displayNames: readonly (string | null | undefined)[]): string {
  const firsts: string[] = [];
  for (const name of displayNames) {
    const trimmed = String(name ?? "").trim();
    if (!trimmed) continue;
    const first = trimmed.split(/\s+/)[0];
    if (first) firsts.push(first);
  }
  if (firsts.length === 0) return "Hi,";
  if (firsts.length > 3) return "Hi all,";
  if (firsts.length === 1) return `Hi ${firsts[0]},`;
  if (firsts.length === 2) return `Hi ${firsts[0]} and ${firsts[1]},`;
  return `Hi ${firsts[0]}, ${firsts[1]} and ${firsts[2]},`;
}
