// Read the first names of the override group (sc_lock_override on an
// ACTIVE people row), for the PERIOD_CLOSED refusal message. Names
// come from `people`, never a string in code.
//
// Returns a plain English list: "A, B or C" (three today). On any
// failure returns a safe fallback: "the office".
//
// Never throws; log and fall back.

import type { SupabaseClient } from "@supabase/supabase-js";

export async function listOverrideFirstNames(
  sb: SupabaseClient,
): Promise<string> {
  try {
    const { data, error } = await sb
      .from("people")
      .select("display_name")
      .eq("is_sc_lock_override", true)
      .eq("status", "ACTIVE")
      .limit(20);
    if (error) {
      console.error(`[reopen/overrideNames] people lookup failed`);
      return "the office";
    }
    const firsts = new Set<string>();
    for (const r of (data ?? []) as Array<{ display_name: string | null }>) {
      const full = (r.display_name ?? "").trim();
      if (!full) continue;
      const first = full.split(/\s+/)[0];
      if (first) firsts.add(first);
    }
    const arr = Array.from(firsts).sort();
    if (arr.length === 0) return "the office";
    if (arr.length === 1) return arr[0];
    if (arr.length === 2) return `${arr[0]} or ${arr[1]}`;
    return `${arr.slice(0, -1).join(", ")} or ${arr[arr.length - 1]}`;
  } catch (err) {
    console.error(
      `[reopen/overrideNames] threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    return "the office";
  }
}
