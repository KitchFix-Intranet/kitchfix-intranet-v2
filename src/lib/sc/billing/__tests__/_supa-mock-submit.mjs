// Wrapper around _supa-mock.mjs for the submit library tests.
// `_supa-mock.mjs` is one of the 18 byte-identical files and cannot
// be edited. This wrapper layers two things on top of its `insert`
// path without changing it:
//
//   1. A unique-violation refusal with Postgres code 23505 when a
//      second LIVE row for the same (account_key, week_start) is
//      inserted. "Live" = status not 'reverted'. The engine's
//      sc_week_finalize index has this shape; the base mock does
//      not enforce it. Without this, the submit tests cannot prove
//      the race-loser gets ALREADY_SUBMITTED.
//
//   2. An `.is("col", null)` and `.not("col", "is", null)` filter
//      on `select` / `update` chains. The base mock already covers
//      most of what the submit path needs; this adds the null tests
//      for push_done_at / push_gave_up_at / push_next_try_at and
//      submitted_via on the claim and on the due-finder.
//
// Everything else - .eq, .in, .gte, .lte, .neq, .maybeSingle,
// .single, .limit, .rpc, _dump, _log - is delegated to the base.
// The tests only reach for what the real submit path writes.

import { makeSupaMock as makeBase } from "./_supa-mock.mjs";

function matchIsNull(row, col, wantNull) {
  const v = row[col];
  const isNull = v == null;
  return wantNull ? isNull : !isNull;
}

export function makeSupaMock(opts) {
  const base = makeBase(opts);

  function chain(table) {
    const state = {
      op: "select",
      filters: [],
      updates: null,
      payload: null,
      returning: false,
      limit: null,
      order: [],
      single: false,
      maybeSingle: false,
    };

    function tableRows() {
      // Mirror the base mock's private store through _dump. Returns
      // a copy; writes go through the base's chain.
      return base._dump(table);
    }

    function applyFilters(rows) {
      let out = rows;
      for (const f of state.filters) {
        if (f.op === "=") out = out.filter((r) => r[f.col] === f.val);
        else if (f.op === "!=") out = out.filter((r) => r[f.col] !== f.val);
        else if (f.op === "<=") out = out.filter((r) => String(r[f.col]) <= String(f.val));
        else if (f.op === ">=") out = out.filter((r) => String(r[f.col]) >= String(f.val));
        else if (f.op === "in") out = out.filter((r) => f.val.includes(r[f.col]));
        else if (f.op === "is_null") out = out.filter((r) => matchIsNull(r, f.col, true));
        else if (f.op === "not_is_null") out = out.filter((r) => matchIsNull(r, f.col, false));
      }
      return out;
    }

    const api = {
      select(cols) {
        // Do not override an already-set op. supabase-js chains like
        // `.insert(row).select("*").single()` set op=insert first; the
        // subsequent `.select()` is a "return the inserted row" modifier,
        // not a switch to select mode. Same for update.
        if (state.op !== "insert" && state.op !== "update") state.op = "select";
        state.cols = cols;
        return api;
      },
      insert(row) { state.op = "insert"; state.payload = row; return api; },
      update(patch) { state.op = "update"; state.updates = patch; return api; },
      eq(col, val) { state.filters.push({ op: "=", col, val }); return api; },
      neq(col, val) { state.filters.push({ op: "!=", col, val }); return api; },
      lte(col, val) { state.filters.push({ op: "<=", col, val }); return api; },
      gte(col, val) { state.filters.push({ op: ">=", col, val }); return api; },
      in(col, val) { state.filters.push({ op: "in", col, val }); return api; },
      is(col, val) {
        // Only `.is(col, null)` is supported here.
        if (val !== null) throw new Error(`mock-submit: .is(col, ${val}) not supported`);
        state.filters.push({ op: "is_null", col });
        return api;
      },
      not(col, op, val) {
        // Only `.not(col, "is", null)` is supported here.
        if (op !== "is" || val !== null) throw new Error(`mock-submit: .not(${op}, ${val}) not supported`);
        state.filters.push({ op: "not_is_null", col });
        return api;
      },
      order(col, { ascending = true } = {}) {
        state.order.push({ col, ascending });
        return api;
      },
      limit(n) { state.limit = n; return api; },
      single() { state.single = true; return exec(); },
      maybeSingle() { state.maybeSingle = true; return exec(); },
      then(onFulfilled, onRejected) { return exec().then(onFulfilled, onRejected); },
    };

    async function exec() {
      // INSERT: enforce unique-violation on (account_key, week_start)
      // where status <> 'reverted'.
      if (state.op === "insert" && table === "sc_week_finalize") {
        const payload = Array.isArray(state.payload) ? state.payload[0] : state.payload;
        const existing = tableRows().filter(
          (r) => r.account_key === payload.account_key
              && r.week_start === payload.week_start
              && r.status !== "reverted",
        );
        if (existing.length > 0) {
          return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        }
        // Delegate to the base mock for the actual insert.
        let baseChain = base.from(table).insert(payload);
        if (state.cols) baseChain = baseChain.select(state.cols);
        if (state.single) return await baseChain.single();
        if (state.maybeSingle) return await baseChain.maybeSingle();
        return await baseChain;
      }

      // UPDATE: respect all filters (including is_null / not_is_null)
      // and apply the patch to every row that matches, then return
      // the rows from the local store.
      if (state.op === "update") {
        const all = tableRows();
        const matched = applyFilters(all);
        // Mutate through the base store. supa-mock does not expose a
        // direct write path; the simplest honest thing is to perform
        // one base .update per matched id so the change lands.
        for (const r of matched) {
          const idCol = "id" in r ? "id" : Object.keys(r)[0];
          await base.from(table).update(state.updates).eq(idCol, r[idCol]);
        }
        const after = tableRows().filter((r) => matched.some((m) => m.id === r.id));
        return { data: after, error: null };
      }

      // SELECT: apply filters in order; delegate to base for simple
      // cases where our added filters are not in play.
      if (state.op === "select") {
        let out = applyFilters(tableRows());
        if (state.order.length > 0) {
          for (const o of state.order) {
            out = out.slice().sort((a, b) => {
              const va = a[o.col]; const vb = b[o.col];
              if (va === vb) return 0;
              if (va == null) return 1;
              if (vb == null) return -1;
              return (o.ascending ? 1 : -1) * (String(va) < String(vb) ? -1 : 1);
            });
          }
        }
        if (state.limit != null) out = out.slice(0, state.limit);
        if (state.single) {
          if (out.length === 0) return { data: null, error: { message: "no row" } };
          return { data: out[0], error: null };
        }
        if (state.maybeSingle) return { data: out[0] || null, error: null };
        return { data: out, error: null };
      }

      throw new Error(`mock-submit: op ${state.op} not supported`);
    }

    return api;
  }

  return {
    from(table) { return chain(table); },
    rpc(name, args) { return base.rpc(name, args); },
    _dump(table) { return base._dump(table); },
    _log() { return base._log(); },
    _base() { return base; },
  };
}
