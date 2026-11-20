// Load notes + history for one (account, date). Three reads in one
// wave. Resolves email authors to display names through `people`,
// never crossing the signed-in email into the response.
//
// The fold stays costless until opened; the loader is called by the
// `GET /api/service/day-note` endpoint (and the drawer's fold).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { HistoryEntry, NotesHistoryView } from "./types";
import { groupHistory } from "./formatHistoryLine";

export interface LoadNotesHistoryInput {
  sb: SupabaseClient;
  accountKey: string;
  serviceDate: string;
}

export async function loadNotesHistory(input: LoadNotesHistoryInput): Promise<NotesHistoryView> {
  const { sb, accountKey, serviceDate } = input;

  const [historyQ, notesQ, firstEnteredQ, servicesQ] = await Promise.all([
    sb.from("sc_daily_actuals_history")
      .select("service_id, old_count, new_count, changed_by, changed_at, change_type")
      .eq("account_key", accountKey)
      .eq("service_date", serviceDate)
      .order("changed_at", { ascending: false })
      .order("service_id", { ascending: true })
      .limit(500),
    sb.from("sc_day_note_entries")
      .select("note, author, created_at, source")
      .eq("account_key", accountKey)
      .eq("service_date", serviceDate)
      .order("created_at", { ascending: false })
      .limit(200),
    sb.from("sc_daily_actuals")
      .select("created_by, created_at")
      .eq("account_key", accountKey)
      .eq("service_date", serviceDate)
      .order("created_at", { ascending: true })
      .limit(100),
    sb.from("sc_services")
      .select("id, service_name")
      .eq("account_key", accountKey),
  ]);

  if (historyQ.error)  throw new Error(`sc_daily_actuals_history: ${historyQ.error.message}`);
  if (notesQ.error)    throw new Error(`sc_day_note_entries: ${notesQ.error.message}`);
  if (firstEnteredQ.error) throw new Error(`sc_daily_actuals: ${firstEnteredQ.error.message}`);
  if (servicesQ.error) throw new Error(`sc_services: ${servicesQ.error.message}`);

  const historyRows = (historyQ.data ?? []) as Array<{
    service_id: string; old_count: number | null; new_count: number | null;
    changed_by: string | null; changed_at: string; change_type: string | null;
  }>;
  const noteRows = (notesQ.data ?? []) as Array<{
    note: string; author: string | null; created_at: string; source: string | null;
  }>;
  const firstEnteredRows = (firstEnteredQ.data ?? []) as Array<{
    created_by: string | null; created_at: string;
  }>;
  const servicesRows = (servicesQ.data ?? []) as Array<{ id: string; service_name: string }>;

  const svcNameById = new Map<string, string>();
  for (const s of servicesRows) svcNameById.set(String(s.id), String(s.service_name));

  // Resolve authors via `people` on work_email. The engine already
  // trims + lower-cases work_email (seasonal rehires carry multiple
  // worker_id rows on the same email); we pick the first display_name
  // we find. An unresolved email -> null (component substitutes
  // "Someone").
  const emails = new Set<string>();
  for (const r of historyRows) if (r.changed_by) emails.add(r.changed_by.toLowerCase().trim());
  for (const r of noteRows) if (r.author) emails.add(r.author.toLowerCase().trim());
  for (const r of firstEnteredRows) if (r.created_by) emails.add(r.created_by.toLowerCase().trim());

  const nameByEmail = await resolveNamesByEmail(sb, Array.from(emails));

  const resolve = (email: string | null): string | null => {
    if (!email) return null;
    return nameByEmail.get(email.toLowerCase().trim()) ?? null;
  };

  const entries: HistoryEntry[] = [];

  // First-entered synthesized row (earliest created_at + its author).
  if (firstEnteredRows.length > 0) {
    let earliest = firstEnteredRows[0];
    for (const r of firstEnteredRows) {
      if (r.created_at < earliest.created_at) earliest = r;
    }
    entries.push({
      kind: "first_entered",
      authorDisplayName: resolve(earliest.created_by),
      at: earliest.created_at,
    });
  }

  for (const r of historyRows) {
    const old = Number(r.old_count ?? 0);
    const neu = Number(r.new_count ?? 0);
    const changeType = r.change_type ?? "update";
    const svcName = svcNameById.get(String(r.service_id)) ?? "(archived service)";
    if (changeType === "delete") {
      entries.push({
        kind: "actual_delete",
        serviceId: String(r.service_id),
        serviceName: svcName,
        oldCount: old,
        authorDisplayName: resolve(r.changed_by),
        at: r.changed_at,
      });
    } else {
      entries.push({
        kind: "actual_change",
        serviceId: String(r.service_id),
        serviceName: svcName,
        oldCount: old,
        newCount: neu,
        authorDisplayName: resolve(r.changed_by),
        at: r.changed_at,
      });
    }
  }

  for (const r of noteRows) {
    entries.push({
      kind: "note",
      text: r.note,
      authorDisplayName: resolve(r.author),
      at: r.created_at,
      source: r.source === "bulk" ? "bulk" : null,
    });
  }

  // Sort newest-first across all three sources.
  entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  const items = groupHistory(entries);

  return {
    accountKey,
    serviceDate,
    items,
    totalCount: entries.length,
  };
}

async function resolveNamesByEmail(
  sb: SupabaseClient,
  emails: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (emails.length === 0) return out;
  // Case-insensitive match; take any one display_name per email
  // (seasonal rehires: multiple worker_id rows map to the same
  // email; a display name is the same across them in practice).
  const { data, error } = await sb.from("people")
    .select("work_email, display_name, status")
    .in("work_email", emails.map((e) => e.toLowerCase().trim()))
    .limit(500);
  if (error) {
    // Non-fatal: fall through with an empty map; callers substitute
    // "Someone" for unresolved authors.
    console.error(`[notesHistory] people lookup failed: ${error.message}`);
    return out;
  }
  const rows = (data ?? []) as Array<{ work_email: string; display_name: string; status: string | null }>;
  // Prefer ACTIVE rows when both exist.
  for (const r of rows.filter((x) => x.status === "ACTIVE")) {
    const k = r.work_email.toLowerCase().trim();
    if (!out.has(k)) out.set(k, r.display_name);
  }
  for (const r of rows.filter((x) => x.status !== "ACTIVE")) {
    const k = r.work_email.toLowerCase().trim();
    if (!out.has(k)) out.set(k, r.display_name);
  }
  return out;
}
