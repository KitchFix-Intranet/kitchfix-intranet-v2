// Thin in-memory supa-shape adapter for resolveFinalizeReviewSpan.
//
// The engine helper makes two reads:
//   1. sc_qbo_account_map .select("cadence").eq("account_key", k).maybeSingle()
//   2. sc_day_metadata    .select("week_label").eq("account_key", k).eq("service_date", d).maybeSingle()
//
// Both answers are in memory already by the time the loader calls the
// helper, so the adapter serves them from a cache. Any other call
// shape THROWS - no silent empty answer. A test runs the real engine
// function through this adapter and through the existing test mock on
// the same rows; the two answers must match.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface InScopeCache {
  accountKey: string;
  cadence: "weekly" | "biweekly" | null;
  // week_label keyed by service_date ISO. Only Monday rows are read by
  // the helper. Missing key means "no row" (the helper tolerates that).
  weekLabelByDate: Map<string, string | null>;
}

// Build a supa-shape from the cache. Only the two reads the engine
// helper makes are recognised; everything else throws so the test will
// fail LOUDLY if the engine's reads ever change.
export function makeInScopeAdapter(cache: InScopeCache): SupabaseClient {
  const from = (table: string): Chain => {
    if (table === "sc_qbo_account_map") {
      return mapChain(cache);
    }
    if (table === "sc_day_metadata") {
      return metaChain(cache);
    }
    throw new Error(`inScopeAdapter: unexpected from(${JSON.stringify(table)}); engine helper changed shape`);
  };
  return { from } as unknown as SupabaseClient;
}

type Chain = {
  select: (cols: string) => Chain;
  eq: (col: string, val: string) => Chain;
  maybeSingle: () => Promise<{ data: unknown; error: null }>;
};

interface MapState {
  selected: boolean;
  accountKeyFilter: string | null;
}

function mapChain(cache: InScopeCache): Chain {
  const st: MapState = { selected: false, accountKeyFilter: null };
  const chain: Chain = {
    select: (cols: string) => {
      if (cols !== "cadence") {
        throw new Error(`inScopeAdapter: sc_qbo_account_map select expected "cadence", got ${JSON.stringify(cols)}`);
      }
      st.selected = true;
      return chain;
    },
    eq: (col: string, val: string) => {
      if (col !== "account_key") {
        throw new Error(`inScopeAdapter: sc_qbo_account_map eq expected "account_key", got ${JSON.stringify(col)}`);
      }
      st.accountKeyFilter = val;
      return chain;
    },
    maybeSingle: async () => {
      if (!st.selected) throw new Error("inScopeAdapter: sc_qbo_account_map maybeSingle before select");
      if (st.accountKeyFilter === null) throw new Error("inScopeAdapter: sc_qbo_account_map maybeSingle before eq(account_key)");
      if (st.accountKeyFilter !== cache.accountKey) {
        throw new Error(`inScopeAdapter: sc_qbo_account_map account_key ${JSON.stringify(st.accountKeyFilter)} not in cache ${JSON.stringify(cache.accountKey)}`);
      }
      return { data: { cadence: cache.cadence }, error: null };
    },
  };
  return chain;
}

interface MetaState {
  selected: boolean;
  accountKeyFilter: string | null;
  serviceDateFilter: string | null;
}

function metaChain(cache: InScopeCache): Chain {
  const st: MetaState = { selected: false, accountKeyFilter: null, serviceDateFilter: null };
  const chain: Chain = {
    select: (cols: string) => {
      if (cols !== "week_label") {
        throw new Error(`inScopeAdapter: sc_day_metadata select expected "week_label", got ${JSON.stringify(cols)}`);
      }
      st.selected = true;
      return chain;
    },
    eq: (col: string, val: string) => {
      if (col === "account_key") { st.accountKeyFilter = val; return chain; }
      if (col === "service_date") { st.serviceDateFilter = val; return chain; }
      throw new Error(`inScopeAdapter: sc_day_metadata eq expected account_key or service_date, got ${JSON.stringify(col)}`);
    },
    maybeSingle: async () => {
      if (!st.selected) throw new Error("inScopeAdapter: sc_day_metadata maybeSingle before select");
      if (st.accountKeyFilter === null) throw new Error("inScopeAdapter: sc_day_metadata maybeSingle before eq(account_key)");
      if (st.serviceDateFilter === null) throw new Error("inScopeAdapter: sc_day_metadata maybeSingle before eq(service_date)");
      if (st.accountKeyFilter !== cache.accountKey) {
        throw new Error(`inScopeAdapter: sc_day_metadata account_key ${JSON.stringify(st.accountKeyFilter)} not in cache ${JSON.stringify(cache.accountKey)}`);
      }
      const label = cache.weekLabelByDate.has(st.serviceDateFilter)
        ? cache.weekLabelByDate.get(st.serviceDateFilter) ?? null
        : null;
      return { data: label === null ? null : { week_label: label }, error: null };
    },
  };
  return chain;
}
