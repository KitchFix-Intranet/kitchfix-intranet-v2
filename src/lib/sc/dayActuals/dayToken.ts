// Day-level concurrency token.
//
// Kevin ruling 2026-11-17 (1.A): the token is whole-day. Any concurrent
// save to the day trips the clash, even on a different service.
//
// Build:
//   1. Load every (service_id, actual_count, updated_at) row for
//      (account_key, service_date), sorted by service_id ASC.
//   2. Canonicalise as "<n>|<svc>:<count>:<ts>|<svc>:<count>:<ts>|...".
//   3. SHA-256 the canonical string, hex-encode, take the first 16 chars.
//
// The empty-day token is the hash of "0|" - both open and save sides
// agree. A no-op save still rotates the token because the trigger-less
// upsert sets updated_at = now(); that is the safe direction (false
// positives, never false negatives).

import { createHash } from "node:crypto";

export interface TokenRow {
  service_id: string;
  actual_count: number | null;
  updated_at: string | null;
}

export function buildDayToken(rows: TokenRow[]): string {
  const sorted = [...rows].sort((a, b) => a.service_id.localeCompare(b.service_id));
  const canonical = `${sorted.length}|` + sorted
    .map((r) => `${r.service_id}:${r.actual_count ?? ""}:${r.updated_at ?? ""}`)
    .join("|");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
