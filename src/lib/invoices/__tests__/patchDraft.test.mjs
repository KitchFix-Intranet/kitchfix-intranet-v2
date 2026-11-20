import { test } from "node:test";
import { strict as assert } from "node:assert";
import { patchDraft } from "../draftWrite.ts";

// Train 2b fix-before-push #8 / section 4.2.
// A ten-line stand-in client for Supabase-js: every chainable
// method returns the same chain; .maybeSingle() pops the next
// queued response and resolves with it. patchDraft calls
// getDraftById first (one .maybeSingle), then runs its update
// chain (second .maybeSingle), so each test queues two responses
// in that order.
function stubSb(responses) {
  const queue = responses.slice();
  const chain = {
    from: () => chain, select: () => chain, update: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve(queue.shift() ?? { data: null, error: null }),
  };
  return chain;
}

const BASE_ROW = {
  id: "00000000-0000-0000-0000-000000000001",
  account_key: "SITE",
  owner_email: "m@e",
  vendor_id: null, type: "invoice",
  invoice_number: null, invoice_date: null, total_amount: null,
  gl_breakdown: [], answers: {}, screen: null,
  status: "draft", submission_id: null,
  created_at: "2026-11-20T00:00:00Z",
  updated_at: "2026-11-20T00:00:00Z",
  discarded_at: null,
};

test("patchDraft: not_found when the draft does not exist", async () => {
  const sb = stubSb([{ data: null, error: null }]);
  const r = await patchDraft(sb, "m@e", BASE_ROW.id, BASE_ROW.updated_at, { type: "invoice" });
  assert.equal(r.status, "not_found");
});

test("patchDraft: frozen when the draft is not 'draft'", async () => {
  const sb = stubSb([{ data: { ...BASE_ROW, status: "discarded" }, error: null }]);
  const r = await patchDraft(sb, "m@e", BASE_ROW.id, BASE_ROW.updated_at, { type: "invoice" });
  assert.equal(r.status, "frozen");
});

test("patchDraft: conflict when no row matches the If-Match timestamp", async () => {
  // getDraftById returns the row (draft is there + is 'draft'),
  // but the update returns {data: null, error: null} - the
  // If-Match clause filtered everything out.
  const sb = stubSb([
    { data: BASE_ROW, error: null },
    { data: null, error: null },
  ]);
  const r = await patchDraft(sb, "m@e", BASE_ROW.id, BASE_ROW.updated_at, { type: "invoice" });
  assert.equal(r.status, "conflict");
});

test("patchDraft: error when the update returns a DB error", async () => {
  // Example: FK violation on a bad vendor_id. The old code called
  // this a conflict and the client would loop; the new code names
  // it an error so the client backs off.
  const sb = stubSb([
    { data: BASE_ROW, error: null },
    { data: null, error: { code: "23503", message: "fk" } },
  ]);
  const r = await patchDraft(sb, "m@e", BASE_ROW.id, BASE_ROW.updated_at, { vendor_id: "bad" });
  assert.equal(r.status, "error");
  if (r.status === "error") assert.equal(r.detail, "23503");
});

test("patchDraft: error carries a fallback code when the error has no 'code'", async () => {
  const sb = stubSb([
    { data: BASE_ROW, error: null },
    { data: null, error: { message: "no code" } },
  ]);
  const r = await patchDraft(sb, "m@e", BASE_ROW.id, BASE_ROW.updated_at, { type: "credit" });
  assert.equal(r.status, "error");
  if (r.status === "error") assert.equal(r.detail, "error");
});

test("patchDraft: ok when the update returns the new row", async () => {
  const newRow = { ...BASE_ROW, type: "credit", updated_at: "2026-11-20T00:00:01Z" };
  const sb = stubSb([
    { data: BASE_ROW, error: null },
    { data: newRow, error: null },
  ]);
  const r = await patchDraft(sb, "m@e", BASE_ROW.id, BASE_ROW.updated_at, { type: "credit" });
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.equal(r.row.type, "credit");
    assert.equal(r.row.updated_at, "2026-11-20T00:00:01Z");
  }
});
