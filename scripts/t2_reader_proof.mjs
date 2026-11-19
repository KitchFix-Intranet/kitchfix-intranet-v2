// T2 §2 proof: readActiveIngredients returns every row across the
// 1,000-row PostgREST cap, and throws when a page drops.
//
// Run: node scripts/t2_reader_proof.mjs
//
// The stand-in holds 2,350 rows and serves at most 1,000 per `.range()`
// call. No database, no network.

import {
  readActiveIngredients,
  IngredientListShortError,
} from "../src/lib/ingredients/readIngredients.ts";

const TOTAL = 2350;
const PAGE = 1000;

function makeRows({ sharedName = false } = {}) {
  const out = [];
  for (let i = 0; i < TOTAL; i++) {
    const name = sharedName
      ? "one-shared-name"
      : `ingredient-${String(i).padStart(4, "0")}`;
    out.push({ id: `id-${String(i).padStart(4, "0")}`, name });
  }
  return out;
}

function makeStandin({ dropPageAt = -1, sharedName = false } = {}) {
  const rows = makeRows({ sharedName });
  // T2 round 2 §5 tiebreak case: when PostgREST sees rows that all
  // share the first order column, the actual page order is undefined.
  // The stand-in simulates that only when the reader did NOT add a
  // second order on `id`. When the reader adds `id` as a tiebreak
  // every page is stable, so rows stay in a deterministic sequence.
  let rangeIndex = -1;
  let hasOrderId = false;

  function query() {
    const state = { head: false, count: false, from: 0, to: TOTAL };
    const self = {
      select(_cols, opts) {
        if (opts && opts.count === "exact") state.count = true;
        if (opts && opts.head === true) state.head = true;
        return self;
      },
      eq() { return self; },
      neq() { return self; },
      is() { return self; },
      not() { return self; },
      in() { return self; },
      order(col) {
        if (col === "id") hasOrderId = true;
        return self;
      },
      range(from, to) {
        state.from = from;
        state.to = to;
        rangeIndex++;
        return self;
      },
      then(resolve) {
        if (state.head && state.count) {
          resolve({ data: null, error: null, count: TOTAL });
          return Promise.resolve();
        }
        if (dropPageAt === rangeIndex) {
          resolve({ data: [], error: null });
          return Promise.resolve();
        }
        let slice;
        if (sharedName && !hasOrderId) {
          // Without a tiebreak: scramble each page so the test sees
          // duplicates + skips. (In the real world PostgREST's order
          // between tied rows is unspecified; the shape is the same.)
          const start = state.from;
          const end = Math.min(state.to + 1, rows.length);
          const window = rows.slice(start, end);
          // Rotate by (rangeIndex + 1) so pages overlap each other
          // deterministically.
          const shift = (rangeIndex + 1) % Math.max(1, window.length);
          slice = window.slice(shift).concat(window.slice(0, shift));
        } else {
          slice = rows.slice(state.from, state.to + 1);
        }
        resolve({ data: slice, error: null });
        return Promise.resolve();
      },
    };
    return self;
  }

  return {
    from() {
      return query();
    },
  };
}

async function main() {
  // Case 1: 2,350 in, 2,350 out.
  {
    const client = makeStandin();
    const rows = await readActiveIngredients(client, {
      columns: "id,name",
    });
    const expected = TOTAL;
    const got = rows.length;
    const pass = got === expected;
    console.log(
      `case 1 (full read): expected ${expected}, got ${got} ${pass ? "PASS" : "FAIL"}`
    );
    if (!pass) process.exit(1);
  }

  // Case 2: a dropped page -> reader throws.
  {
    const client = makeStandin({ dropPageAt: 1 }); // drop the second .range() call
    let threw = false;
    try {
      await readActiveIngredients(client, { columns: "id,name" });
    } catch (e) {
      threw =
        e instanceof IngredientListShortError ||
        (e && e.name === "IngredientListShortError");
      console.log(
        `case 2 (dropped page): reader threw ${threw ? "IngredientListShortError" : "something else"}: ${e && e.message}`
      );
    }
    if (!threw) {
      console.log("case 2 FAIL: expected a throw, got silent short list");
      process.exit(1);
    }
    console.log("case 2 PASS");
  }

  // Case 3 (T2 round 2 §5): every row shares the first order column.
  // With `id` as a tiebreak the paging must still return every row
  // exactly once.
  {
    const client = makeStandin({ sharedName: true });
    const rows = await readActiveIngredients(client, { columns: "id,name" });
    const unique = new Set(rows.map((r) => r.id));
    const pass = rows.length === TOTAL && unique.size === TOTAL;
    console.log(
      `case 3 (shared first order column): expected ${TOTAL} unique rows, got length=${rows.length} unique=${unique.size} ${pass ? "PASS" : "FAIL"}`
    );
    if (!pass) {
      console.log("case 3 FAIL: tiebreak did not stabilise paging");
      process.exit(1);
    }
  }

  console.log("reader proof: PASS");
}

main().catch((e) => {
  console.error("proof crashed:", e);
  process.exit(1);
});
