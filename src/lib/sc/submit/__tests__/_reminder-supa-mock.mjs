// Tiny Supabase client mock for the reminderSend orchestration
// tests. Supports what reminderSend + reminderRecipients +
// resolveFinalizeReviewSpan call: .eq/.in/.neq/.not/.order,
// .select with { count: "exact", head: true }, .maybeSingle(),
// .single(), .insert({...}).select("id").single(),
// .update({...}).eq(...).
//
// Each test file seeds in-memory rows per table via makeReminderSupa
// and inspects captured .insert / .update calls through the returned
// `log` array. Week labels are the strings the database stores:
// "Week 1" ... "Week 4" (matches parseWeekIndex in scWeekFinalize.ts).

export function makeReminderSupa(seed = {}) {
  const tables = new Map();
  for (const [name, rows] of Object.entries(seed)) {
    tables.set(name, (rows ?? []).map((r) => ({ ...r })));
  }
  const log = [];

  function chain(table) {
    const state = {
      op: "select",
      filters: [],
      returning: null,
      payload: null,
      updates: null,
      head: false,
      single: false,
      maybeSingle: false,
      order: [],
    };

    function applyFilters(rows) {
      let out = rows;
      for (const f of state.filters) {
        if (f.op === "=") out = out.filter((r) => r[f.col] === f.val);
        else if (f.op === "!=") out = out.filter((r) => r[f.col] !== f.val);
        else if (f.op === "in") out = out.filter((r) => f.val.includes(r[f.col]));
        else if (f.op === "is_null") out = out.filter((r) => r[f.col] == null);
        else if (f.op === "not_is_null") out = out.filter((r) => r[f.col] != null);
      }
      return out;
    }

    const api = {
      select(cols, opts) {
        if (state.op === "select") state.returning = cols;
        if (opts && opts.head === true) state.head = true;
        return api;
      },
      insert(payload) { state.op = "insert"; state.payload = payload; return api; },
      update(patch) { state.op = "update"; state.updates = patch; return api; },
      eq(col, val) { state.filters.push({ op: "=", col, val }); return api; },
      neq(col, val) { state.filters.push({ op: "!=", col, val }); return api; },
      in(col, val) { state.filters.push({ op: "in", col, val }); return api; },
      is(col, val) {
        if (val !== null) throw new Error(`mock .is(col, ${val})`);
        state.filters.push({ op: "is_null", col });
        return api;
      },
      not(col, op, val) {
        if (op !== "is" || val !== null) throw new Error(`mock .not(${op}, ${val})`);
        state.filters.push({ op: "not_is_null", col });
        return api;
      },
      order(col, { ascending = true } = {}) { state.order.push({ col, ascending }); return api; },
      single() { state.single = true; return exec(); },
      maybeSingle() { state.maybeSingle = true; return exec(); },
      then(onFulfilled, onRejected) { return exec().then(onFulfilled, onRejected); },
    };

    async function exec() {
      const rows = tables.get(table) ?? (tables.set(table, []), tables.get(table));
      if (state.op === "select") {
        const filtered = applyFilters(rows);
        for (const o of state.order) {
          filtered.sort((a, b) => {
            const av = a[o.col], bv = b[o.col];
            if (av === bv) return 0;
            const cmp = av == null ? 1 : bv == null ? -1 : (av < bv ? -1 : 1);
            return o.ascending ? cmp : -cmp;
          });
        }
        if (state.head) return { data: null, count: filtered.length, error: null };
        if (state.single) return filtered.length === 1
          ? { data: filtered[0], error: null }
          : { data: null, error: { message: "no single row" } };
        if (state.maybeSingle) return { data: filtered[0] ?? null, error: null };
        return { data: filtered, error: null };
      }
      if (state.op === "insert") {
        const payload = Array.isArray(state.payload) ? state.payload[0] : state.payload;
        const row = { id: payload.id ?? `row-${rows.length + 1}`, ...payload };
        // Enforce unique on sc_v2_reminder_sent
        if (table === "sc_v2_reminder_sent") {
          const dup = rows.find(
            (r) => r.account_key === row.account_key
                && r.week_start === row.week_start
                && r.stage === row.stage
                && r.is_test === row.is_test,
          );
          if (dup) {
            log.push({ table, op: "insert_rejected_duplicate", row });
            return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
          }
        }
        rows.push(row);
        log.push({ table, op: "insert", row });
        if (state.single || state.maybeSingle) return { data: row, error: null };
        return { data: [row], error: null };
      }
      if (state.op === "update") {
        const target = applyFilters(rows);
        for (const r of target) Object.assign(r, state.updates);
        log.push({ table, op: "update", patch: state.updates, matched: target.length });
        return { data: target, error: null };
      }
      throw new Error(`unsupported op ${state.op}`);
    }

    return api;
  }

  const client = { from: (table) => chain(table), _log: log, _tables: tables };
  return client;
}
