// T3.1 fix 4 (2026-11-13). One site-resolver for the inbox + the
// record drawer. Travel rows carry a site in up to three places,
// depending on when the form was filled:
//
//   1. payload.locationName   - the clean club name (newer forms).
//   2. payload.locationKey    - a combined "TEAM - City - Club Name"
//                               string (older forms left locationName
//                               empty but populated this).
//   3. submissions.location   - same combined string, outside the
//                               payload (older still).
//
// The accounts table holds `team_key` ("STL - FL") and `name`
// ("St Louis Cardinals") separately; the combo in (2) and (3)
// is `"${team_key} - ${name}"`. All 11 distinct travel-site strings
// in the DB match this pattern today. Unknown strings fall back to
// their literal value so the viewer never sees a blank site.

export interface SiteIndex {
  // key -> canonical name. Populated for both bare team_key and the
  // "team_key - name" combo so a single Map handles any source.
  byKey: Map<string, string>;
}

export function buildSiteIndex(accounts: Array<{ team_key: string; name: string | null }>): SiteIndex {
  const byKey = new Map<string, string>();
  for (const a of accounts) {
    const name = (a.name ?? "").trim();
    if (!name) continue;
    byKey.set(a.team_key, name);
    byKey.set(`${a.team_key} - ${name}`, name);
  }
  return { byKey };
}

// Resolve a site name from the three possible inputs. Returns null
// when nothing is set at all; the caller decides between omitting
// the site (title fallback) and printing "Not given" (drawer).
export function resolveSite(
  payloadLocationName: unknown,
  payloadLocationKey: unknown,
  submissionsLocation: string | null | undefined,
  index: SiteIndex,
): string | null {
  const name = String(payloadLocationName ?? "").trim();
  if (name) return name;
  const key = String(payloadLocationKey ?? "").trim();
  if (key) {
    const resolved = index.byKey.get(key);
    if (resolved) return resolved;
    // A combo string we do not recognise: strip a "TEAM - " prefix
    // so an unmapped site still prints as its tail. If no " - "
    // is in the string, fall back to the literal.
    const parts = key.split(" - ");
    if (parts.length >= 2) return parts.slice(1).join(" - ");
    return key;
  }
  const loc = (submissionsLocation ?? "").trim();
  if (loc) {
    const resolved = index.byKey.get(loc);
    if (resolved) return resolved;
    const parts = loc.split(" - ");
    if (parts.length >= 2) return parts.slice(1).join(" - ");
    return loc;
  }
  return null;
}
