// src/lib/academy/cycles.ts
//
// Admin-only loader for /academy/admin. Reads academy_cycles, each
// cycle's module count (academy_cycle_modules) and issued-
// requirement count (academy_requirements where cycle_id =).
//
// Also exposes a helper to list academy_obligations (for the Create
// Cycle module picker) and to load a single draft cycle for the
// (future) Edit path. These are owner-only data; every caller is
// already behind requireOwnerPage() / requireOwnerApi().

import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "@/lib/supabase/service";

export type CycleStatus = "draft" | "published" | "closed";

export interface CycleRow {
  cycle_id: string | number;
  label: string;
  period_start: string | null;
  period_end: string | null;
  status: CycleStatus;
  fiscal_year: number | null;
  fiscal_period_no: number | null;
  audience_scope: Record<string, unknown> | null;
  created_at: string | null;
  created_by: string | null;
  published_at: string | null;
  published_by: string | null;
  closed_at: string | null;
}

export interface CycleRowWithCounts extends CycleRow {
  moduleCount: number;
  issuedCount: number;
}

export async function loadCycles(supaIn?: SupabaseClient): Promise<CycleRowWithCounts[]> {
  const supa = supaIn || serviceClient();
  const q = await supa
    .from("academy_cycles")
    .select(
      "cycle_id, label, period_start, period_end, status, fiscal_year, fiscal_period_no, audience_scope, created_at, created_by, published_at, published_by, closed_at",
    )
    .order("period_start", { ascending: false, nullsFirst: false });
  if (q.error) throw new Error(`loadCycles: ${q.error.message}`);
  const rows = (q.data as CycleRow[]) || [];
  if (rows.length === 0) return [];

  const cycleIds = rows.map((r) => r.cycle_id);
  // Module count per cycle (small table, scan-and-tally client-side).
  const modQ = await supa
    .from("academy_cycle_modules")
    .select("cycle_id")
    .in("cycle_id", cycleIds);
  if (modQ.error) throw new Error(`loadCycles modules: ${modQ.error.message}`);
  const modCount = new Map<string | number, number>();
  for (const m of (modQ.data as Array<{ cycle_id: string | number }>) || []) {
    modCount.set(m.cycle_id, (modCount.get(m.cycle_id) ?? 0) + 1);
  }
  // Issued count per cycle. academy_requirements is wider but a
  // single-column pull keyed by cycle_id is still a point read; the
  // engine's cycle count is low (one row today).
  const reqQ = await supa
    .from("academy_requirements")
    .select("cycle_id")
    .in("cycle_id", cycleIds);
  if (reqQ.error) throw new Error(`loadCycles requirements: ${reqQ.error.message}`);
  const reqCount = new Map<string | number, number>();
  for (const r of (reqQ.data as Array<{ cycle_id: string | number }>) || []) {
    reqCount.set(r.cycle_id, (reqCount.get(r.cycle_id) ?? 0) + 1);
  }

  return rows.map((r) => ({
    ...r,
    moduleCount: modCount.get(r.cycle_id) ?? 0,
    issuedCount: reqCount.get(r.cycle_id) ?? 0,
  }));
}

export interface ObligationPickRow {
  doc_id: string;
  obligation_key: string;
  doc_version: string | number | null;
  est_minutes: number | null;
  type: string | null;
  cadence: string | null;
  description: string | null;
}

// Lightweight list of obligations for the Create Cycle module picker.
// Not keyed by cycle; just the catalog of what CAN be put in a cycle.
export async function loadObligationsCatalog(
  supaIn?: SupabaseClient,
): Promise<ObligationPickRow[]> {
  const supa = supaIn || serviceClient();
  const q = await supa
    .from("academy_obligations")
    .select("doc_id, obligation_key, doc_version, est_minutes, type, cadence, description")
    .order("doc_id", { ascending: true })
    .order("obligation_key", { ascending: true });
  if (q.error) throw new Error(`loadObligationsCatalog: ${q.error.message}`);
  return (q.data as ObligationPickRow[]) || [];
}

// A single draft cycle for the Edit path. Returns null when the
// cycle does not exist or is not in draft.
export interface DraftCycle extends CycleRow {
  modules: Array<{
    doc_id: string;
    obligation_key: string;
    doc_version: string | number | null;
    est_minutes: number | null;
    sort_order: number | null;
  }>;
}

export async function loadDraftCycle(
  cycleId: string | number,
  supaIn?: SupabaseClient,
): Promise<DraftCycle | null> {
  const supa = supaIn || serviceClient();
  const cycleQ = await supa
    .from("academy_cycles")
    .select(
      "cycle_id, label, period_start, period_end, status, fiscal_year, fiscal_period_no, audience_scope, created_at, created_by, published_at, published_by, closed_at",
    )
    .eq("cycle_id", cycleId)
    .maybeSingle();
  if (cycleQ.error) throw new Error(`loadDraftCycle: ${cycleQ.error.message}`);
  if (!cycleQ.data) return null;
  const row = cycleQ.data as CycleRow;
  if (row.status !== "draft") return null;
  const modQ = await supa
    .from("academy_cycle_modules")
    .select("doc_id, obligation_key, doc_version, est_minutes, sort_order")
    .eq("cycle_id", cycleId)
    .order("sort_order", { ascending: true });
  if (modQ.error) throw new Error(`loadDraftCycle modules: ${modQ.error.message}`);
  const modules = (modQ.data as DraftCycle["modules"]) || [];
  return { ...row, modules };
}
