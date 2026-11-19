// Vendor picker data loader. Server.
//
// §6: picker searches by name and by alias (`vendor_aliases`). This
// site's own vendors (an active `vendor_accounts` row) come first.
// A deleted vendor (`deleted_at` set) is never offered. We SELECT
// only `vendor_id, account_key, active` from `vendor_accounts` (§5
// hard rule: never select portal_*, customer_account_num, sales_rep_*).
//
// Search safety: the invoices lane never uses `.or()` with user text
// (see train 1's duplicate scope rule). Here we run two scoped
// `.ilike` queries (name + alias) and merge by vendor id.

import type { SupabaseClient } from "@supabase/supabase-js";
import { escapeLike } from "./escape";

export interface VendorPick {
  id: string;
  name: string;
  category: string | null;
  // true if this vendor has an active vendor_accounts row for the
  // viewer's site. Those come first in the picker.
  isSiteVendor: boolean;
}

export interface VendorPickerArgs {
  sb: SupabaseClient;
  accountKey: string;
  q: string | null;
  limit?: number;
}

export async function searchVendors({ sb, accountKey, q, limit = 50 }: VendorPickerArgs): Promise<VendorPick[]> {
  // The site's own active vendor ids. SELECT only the three columns
  // the lane may read.
  const vaQ = await sb
    .from("vendor_accounts")
    .select("vendor_id, account_key, active")
    .eq("account_key", accountKey)
    .eq("active", true);
  const siteVendorIds = new Set<string>();
  if (!vaQ.error) {
    for (const row of (vaQ.data ?? []) as Array<{ vendor_id: string | null }>) {
      if (row.vendor_id) siteVendorIds.add(row.vendor_id);
    }
  }

  const like = q && q.trim() ? `%${escapeLike(q.trim())}%` : null;

  // Query A: match by vendor name (live vendors only).
  const aQ = like
    ? await sb.from("vendors").select("id, name, category, deleted_at").is("deleted_at", null).ilike("name", like).limit(limit)
    : await sb.from("vendors").select("id, name, category, deleted_at").is("deleted_at", null).order("name").limit(limit);
  const byId = new Map<string, VendorPick>();
  for (const row of (aQ.data ?? []) as Array<{ id: string; name: string; category: string | null }>) {
    byId.set(row.id, { id: row.id, name: row.name, category: row.category, isSiteVendor: siteVendorIds.has(row.id) });
  }

  // Query B: match by alias (also returns vendor_id). Only when there
  // is a query.
  if (like) {
    const bQ = await sb
      .from("vendor_aliases")
      .select("vendor_id, alias_text")
      .ilike("alias_normalized", like)
      .limit(limit);
    const aliasVendorIds = Array.from(new Set(
      ((bQ.data ?? []) as Array<{ vendor_id: string | null }>).map((r) => r.vendor_id).filter((v): v is string => !!v)
    ));
    if (aliasVendorIds.length > 0) {
      const extraQ = await sb
        .from("vendors")
        .select("id, name, category, deleted_at")
        .in("id", aliasVendorIds)
        .is("deleted_at", null)
        .limit(limit);
      for (const row of (extraQ.data ?? []) as Array<{ id: string; name: string; category: string | null }>) {
        if (!byId.has(row.id)) {
          byId.set(row.id, { id: row.id, name: row.name, category: row.category, isSiteVendor: siteVendorIds.has(row.id) });
        }
      }
    }
  }

  // Sort: site vendors first, then alphabetical.
  return Array.from(byId.values())
    .sort((a, b) => {
      if (a.isSiteVendor !== b.isSiteVendor) return a.isSiteVendor ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, limit);
}

// Is this vendor an in-scope choice for this site?
// Returns true when the vendor exists, is not deleted; passes
// regardless of a vendor_accounts row (a person may capture an
// invoice from a one-off vendor even without a site account yet).
export async function vendorIsAvailable(
  sb: SupabaseClient,
  vendorId: string,
): Promise<boolean> {
  const q = await sb
    .from("vendors")
    .select("id, deleted_at")
    .eq("id", vendorId)
    .maybeSingle();
  if (q.error || !q.data) return false;
  const row = q.data as { id: string; deleted_at: string | null };
  return row.deleted_at === null;
}
