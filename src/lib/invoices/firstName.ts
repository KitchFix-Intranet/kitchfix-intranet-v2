// Sender first-name resolver (§5).
//
// Rule:
//   - Exactly one ACTIVE people row for the email -> that row's
//     display_name, first word.
//   - No ACTIVE match AND every row (active or not) with that email
//     carries the same display_name -> that display_name, first word.
//   - Otherwise -> null (the screen shows no name; never the email).
//
// The caller fetches both the active rows and the full rows in one
// query per page (one `.in("work_email", emails)`); this function is
// pure.

export interface PeopleRowLite {
  work_email: string | null;
  display_name: string | null;
  status: string | null;
}

export function firstWord(name: string | null): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  const first = trimmed.split(/\s+/)[0];
  return first || null;
}

export function resolveFirstNames(
  emails: readonly string[],
  rows: readonly PeopleRowLite[],
): Map<string, string | null> {
  // Group by lower-cased email.
  const byEmail = new Map<string, PeopleRowLite[]>();
  for (const r of rows) {
    const e = String(r.work_email ?? "").toLowerCase().trim();
    if (!e) continue;
    const bucket = byEmail.get(e) ?? [];
    bucket.push(r);
    byEmail.set(e, bucket);
  }

  const out = new Map<string, string | null>();
  for (const raw of emails) {
    const e = String(raw ?? "").toLowerCase().trim();
    if (!e) continue;
    const bucket = byEmail.get(e) ?? [];
    if (bucket.length === 0) { out.set(e, null); continue; }

    // Any ACTIVE row?
    const actives = bucket.filter((r) => String(r.status ?? "").toUpperCase() === "ACTIVE");
    if (actives.length === 1) {
      out.set(e, firstWord(actives[0].display_name));
      continue;
    }
    if (actives.length > 1) {
      // Multiple ACTIVE rows: unambiguous only if they agree.
      const names = new Set(actives.map((r) => (r.display_name ?? "").trim()).filter(Boolean));
      out.set(e, names.size === 1 ? firstWord(actives[0].display_name) : null);
      continue;
    }

    // No ACTIVE rows: require every row to carry the same name.
    const names = new Set(bucket.map((r) => (r.display_name ?? "").trim()).filter(Boolean));
    if (names.size === 1) {
      out.set(e, firstWord(bucket[0].display_name));
    } else {
      out.set(e, null);
    }
  }
  return out;
}
