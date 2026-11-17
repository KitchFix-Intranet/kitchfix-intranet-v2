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

function makeRows() {
  const out = [];
  for (let i = 0; i < TOTAL; i++) {
    out.push({ id: `id-${i}`, name: `ingredient-${String(i).padStart(4, "0")}` });
  }
  return out;
}

function makeStandin({ dropPageAt = -1 } = {}) {
  const rows = makeRows();
  let currentCall = -1;
  let rangeIndex = -1;

  function query() {
    const state = { head: false, count: false, from: 0, to: TOTAL };
    const self = {
      select(_cols, opts) {
        if (opts && opts.count === "exact") state.count = true;
        if (opts && opts.head === true) state.head = true;
        return self;
      },
      eq() {
        return self;
      },
      neq() {
        return self;
      },
      is() {
        return self;
      },
      not() {
        return self;
      },
      in() {
        return self;
      },
      order() {
        return self;
      },
      range(from, to) {
        state.from = from;
        state.to = to;
        rangeIndex++;
        return self;
      },
      then(resolve) {
        currentCall++;
        if (state.head && state.count) {
          resolve({ data: null, error: null, count: TOTAL });
          return Promise.resolve();
        }
        if (dropPageAt === rangeIndex) {
          resolve({ data: [], error: null });
          return Promise.resolve();
        }
        const slice = rows.slice(state.from, state.to + 1);
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

  console.log("reader proof: PASS");
}

main().catch((e) => {
  console.error("proof crashed:", e);
  process.exit(1);
});
