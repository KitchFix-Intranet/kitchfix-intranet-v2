// Train 5a / D3 call 1: whole-catalog counts for the Vendor items
// top-bar header. The ruling says header facts are for the whole tab,
// not the current vendor filter or chip; the page's own `readSegCounts`
// still applies the user's vendor. These counts are the two the header
// shows (every line we've read; items not matched yet) and do not
// take a filter.
//
// Wrapped in React.cache() so a future fact reader (a second slot on
// the same tab, say) does not pay the round trip twice per request.

import { cache } from "react";
import { serviceClient } from "@/lib/supabase/service";

export type VendorItemsHeader = {
  // Every row in the active catalog (same six statuses the page's
  // "All" chip counts).
  all: number;
  // Food items with no link at all (link_status='none',
  // is_food=true, status in active/resale). Same number the
  // "Not linked" chip counts on this tab and the "items not
  // matched yet" fact on the Review queue tab.
  unlinked: number;
};

export const loadVendorItemsHeader = cache(
  async function loadVendorItemsHeader(): Promise<VendorItemsHeader> {
    const client = serviceClient();
    const [allRes, unlinkedRes] = await Promise.all([
      client
        .from("pr_vendor_items")
        .select("id", { count: "exact", head: true })
        .in("status", [
          "active",
          "resale",
          "duplicate",
          "one_off",
          "not_food",
          "archived",
        ]),
      client
        .from("pr_vendor_items")
        .select("id", { count: "exact", head: true })
        .eq("is_food", true)
        .eq("link_status", "none")
        .in("status", ["active", "resale"]),
    ]);
    return {
      all: allRes.count ?? 0,
      unlinked: unlinkedRes.count ?? 0,
    };
  },
);
