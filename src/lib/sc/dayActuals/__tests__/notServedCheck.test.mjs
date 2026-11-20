// Fix 4 (train 4): isMarkedNotServed is the pure check, and the
// route only writes the note when (post) AND !(pre). Three cases:
//   - partial zero -> no note at any stage.
//   - full zero first time -> one note.
//   - full zero re-saved -> no second note.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isMarkedNotServed } from "../notServedCheck.ts";

const PROJ = (ids) => new Set(ids);
const ACT  = (pairs) => new Map(pairs);

test("empty projections -> not not-served (there is nothing projected)", () => {
  assert.equal(
    isMarkedNotServed({
      projectedServiceIds: PROJ([]),
      actualCountByServiceId: ACT([]),
    }),
    false,
  );
});

test("partial zero (1 of 3 projected at 0, others blank) -> false", () => {
  assert.equal(
    isMarkedNotServed({
      projectedServiceIds: PROJ(["A", "B", "C"]),
      actualCountByServiceId: ACT([["A", 0]]),
    }),
    false,
  );
});

test("full zero (every projected has an actuals row at 0) -> true", () => {
  assert.equal(
    isMarkedNotServed({
      projectedServiceIds: PROJ(["A", "B"]),
      actualCountByServiceId: ACT([["A", 0], ["B", 0]]),
    }),
    true,
  );
});

test("one projected above zero -> false", () => {
  assert.equal(
    isMarkedNotServed({
      projectedServiceIds: PROJ(["A", "B"]),
      actualCountByServiceId: ACT([["A", 0], ["B", 3]]),
    }),
    false,
  );
});

test("extra actuals for a non-projected service do not affect the answer", () => {
  assert.equal(
    isMarkedNotServed({
      projectedServiceIds: PROJ(["A"]),
      actualCountByServiceId: ACT([["A", 0], ["X", 0]]),
    }),
    true,
  );
});

// ── The route's compound rule: note fires only on the flip ─────────

// isNowNotServed=true, wasAlreadyNotServed=false -> write.
test("route rule: first full-zero save fires the note", () => {
  const pre  = isMarkedNotServed({
    projectedServiceIds: PROJ(["A", "B"]),
    actualCountByServiceId: ACT([]),   // nothing saved yet
  });
  const post = isMarkedNotServed({
    projectedServiceIds: PROJ(["A", "B"]),
    actualCountByServiceId: ACT([["A", 0], ["B", 0]]),
  });
  assert.equal(pre, false);
  assert.equal(post, true);
  assert.equal(post && !pre, true);   // write
});

// Already full-zero, saved again -> no write.
test("route rule: a re-save of an already-not-served day does not fire the note", () => {
  const already = isMarkedNotServed({
    projectedServiceIds: PROJ(["A", "B"]),
    actualCountByServiceId: ACT([["A", 0], ["B", 0]]),
  });
  const after = isMarkedNotServed({
    projectedServiceIds: PROJ(["A", "B"]),
    actualCountByServiceId: ACT([["A", 0], ["B", 0]]),
  });
  assert.equal(already, true);
  assert.equal(after, true);
  assert.equal(after && !already, false);  // no write
});

// Partial zero never flips -> no write.
test("route rule: saving one zero on a mostly-blank day does not fire the note", () => {
  const pre  = isMarkedNotServed({
    projectedServiceIds: PROJ(["A", "B", "C"]),
    actualCountByServiceId: ACT([]),
  });
  const post = isMarkedNotServed({
    projectedServiceIds: PROJ(["A", "B", "C"]),
    actualCountByServiceId: ACT([["A", 0]]),
  });
  assert.equal(pre, false);
  assert.equal(post, false);
  assert.equal(post && !pre, false);
});
