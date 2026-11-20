// Scope: who may reopen a submitted week. Server-only.
//
// Kevin ruling 2026-11-20 (train 5):
//   - Any ACTIVE people row with is_sc_lock_override = true (three
//     people today). No region bind.
//   - Any ACTIVE people row with is_regional_director = true (two
//     people today). Also no region bind — a director acts as office
//     for any site (Nov 17 ruling 2.B).
//
// Rule D (closed period) is NOT checked here; the route applies it
// after reading the helper's answer so a lookup is not spent on a
// sc_is_period_closed_fy rpc the override path does not need.
//
// Returns the role internally. The role is NEVER shipped to the
// client — it drives one server-side branch (the closed-period
// refusal). The page only sees "may this viewer reopen" as a
// boolean.

import type { SupabaseClient } from "@supabase/supabase-js";

export type ReopenRole = "override" | "rd";

export type ReopenAllowed =
  | { ok: true; role: ReopenRole }
  | { ok: false; code: "NOT_ALLOWED"; message: string };

export async function canReopenForAccount(
  sb: SupabaseClient,
  email: string | null,
): Promise<ReopenAllowed> {
  const refuse: ReopenAllowed = {
    ok: false,
    code: "NOT_ALLOWED",
    message: "Reopening a week is for the office and the regional directors.",
  };
  const e = (email ?? "").toLowerCase().trim();
  if (!e) return refuse;

  try {
    const { data, error } = await sb
      .from("people")
      .select("work_email, status, is_sc_lock_override, is_regional_director")
      .eq("work_email", e)
      .eq("status", "ACTIVE")
      .limit(5);
    if (error) {
      console.error("[reopenScope] people lookup failed");
      return refuse;
    }
    const rows = (data ?? []) as Array<{
      is_sc_lock_override: boolean | null;
      is_regional_director: boolean | null;
    }>;
    if (rows.some((r) => r.is_sc_lock_override === true)) {
      return { ok: true, role: "override" };
    }
    if (rows.some((r) => r.is_regional_director === true)) {
      return { ok: true, role: "rd" };
    }
    return refuse;
  } catch (err) {
    console.error(
      `[reopenScope] threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    return refuse;
  }
}
