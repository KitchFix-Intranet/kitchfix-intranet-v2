// Train 6: recipient lookup for the two reminders. Reuses the
// engine's `getSalariedManagerEmails` for site leaders; adds a
// per-region director lookup that returns zero, one, or many.
//
// Kevin ruling 2026-11-20:
//   - site leaders  = people with account_key=X, ACTIVE, is_salaried=true.
//                     Ordered by is_site_leader DESC then display_name.
//   - site RDs      = people with region=R, ACTIVE, is_regional_director=true.
//                     Zero, one, or more.
//   - 0 RDs -> the line reads "tell the office". Message goes to
//              leaders only.
//   - 1 RD  -> included in Monday recipients. The line uses the
//              first name.
//   - >1 RDs -> all of them are included. The line reads
//              "tell your regional director" with no name.
//
// Addresses and display_names come back as a pair. The render passes
// display_name to `reminderGreeting`; addresses go to the sender.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSalariedManagerEmails } from "@/lib/sc/billing/getSalariedManagerEmails";

export interface LeaderPerson {
  email: string;
  displayName: string | null;
  isSiteLeader: boolean;
}

export interface DirectorPerson {
  email: string;
  displayName: string | null;
}

export async function loadSiteLeaders(
  sb: SupabaseClient,
  accountKey: string,
): Promise<LeaderPerson[]> {
  // The engine helper returns emails only. We need display_name for
  // the greeting line, so do a direct read here with the same
  // predicate + ordering. Keeps the engine helper byte-identical.
  const { data, error } = await sb
    .from("people")
    .select("work_email, display_name, is_site_leader")
    .eq("account_key", accountKey)
    .eq("status", "ACTIVE")
    .eq("is_salaried", true)
    .not("work_email", "is", null)
    .order("is_site_leader", { ascending: false, nullsFirst: false })
    .order("display_name", { ascending: true });
  if (error) {
    throw new Error(`loadSiteLeaders(${accountKey}): ${error.message}`);
  }
  const rows = (data ?? []) as Array<{
    work_email: string;
    display_name: string | null;
    is_site_leader: boolean | null;
  }>;
  return rows.map((r) => ({
    email: String(r.work_email).toLowerCase().trim(),
    displayName: r.display_name,
    isSiteLeader: !!r.is_site_leader,
  }));
}

export async function loadRegionDirectors(
  sb: SupabaseClient,
  region: string | null,
): Promise<DirectorPerson[]> {
  if (!region) return [];
  const { data, error } = await sb
    .from("people")
    .select("work_email, display_name")
    .eq("region", region)
    .eq("status", "ACTIVE")
    .eq("is_regional_director", true)
    .not("work_email", "is", null)
    .order("display_name", { ascending: true });
  if (error) {
    throw new Error(`loadRegionDirectors(${region}): ${error.message}`);
  }
  const rows = (data ?? []) as Array<{
    work_email: string;
    display_name: string | null;
  }>;
  return rows.map((r) => ({
    email: String(r.work_email).toLowerCase().trim(),
    displayName: r.display_name,
  }));
}

// The engine's own getSalariedManagerEmails is re-exported here so a
// future caller that needs email-only can import from one place.
export { getSalariedManagerEmails };
