// sc-64 (Kevin ruling 2026-11-16): who may submit for a site.
//
// True when any ACTIVE people row for the given address is one of:
//   - corporate (is_corp)
//   - a regional director whose region equals the account's region
//   - salaried at the account (account_key equal)
//
// False otherwise, and false on any failure. Never throws. No
// address appears in the console.error line or in the returned
// `via` reason (same discipline as admin.isScLockOverrideDb).
//
// Matching: trim, lower-case, `.eq` on work_email (not `ilike`),
// same as admin.ts. Emails sit on more than one people row (one
// per hire), so every rule is "any ACTIVE row for this address
// that...".

import { getServiceClient } from "@/lib/sc/_seams";
import type {
  SupabaseClient,
  SubmitAccess,
  PersonAccessRow,
  AccountRegionRow,
} from "@/lib/sc/types";

export async function canSubmitForAccount(
  email: string | null | undefined,
  accountKey: string,
  supaArg?: SupabaseClient,
): Promise<SubmitAccess> {
  const e = String(email ?? "").trim().toLowerCase();
  if (!e || !accountKey) return { allowed: false, via: null };
  try {
    const supa = supaArg || getServiceClient();
    // Two parallel reads. The people select covers all three rules
    // in one query; the account read covers the regional-director
    // region match.
    const [peopleRes, accountRes] = await Promise.all([
      supa
        .from("people")
        .select("work_email, account_key, status, is_salaried, is_corp, is_regional_director, region")
        .eq("work_email", e)
        .eq("status", "ACTIVE"),
      supa
        .from("accounts")
        .select("team_key, region, timezone")
        .eq("team_key", accountKey)
        .maybeSingle(),
    ]);
    if (peopleRes.error) {
      console.error(`[sc/submit] canSubmitForAccount: ${peopleRes.error.message}`);
      return { allowed: false, via: null };
    }
    if (accountRes.error) {
      console.error(`[sc/submit] canSubmitForAccount: ${accountRes.error.message}`);
      return { allowed: false, via: null };
    }
    const rows: PersonAccessRow[] = peopleRes.data || [];
    const account: AccountRegionRow | null = accountRes.data || null;
    // Rule 1 - corporate.
    if (rows.some((r) => r.is_corp === true)) return { allowed: true, via: "corp" };
    // Rule 2 - regional director whose region matches the account's.
    if (account && account.region) {
      if (rows.some((r) => r.is_regional_director === true && r.region === account.region)) {
        return { allowed: true, via: "regional_director" };
      }
    }
    // Rule 3 - salaried at the account.
    if (rows.some((r) => r.is_salaried === true && r.account_key === accountKey)) {
      return { allowed: true, via: "site" };
    }
    return { allowed: false, via: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[sc/submit] canSubmitForAccount: ${msg}`);
    return { allowed: false, via: null };
  }
}
