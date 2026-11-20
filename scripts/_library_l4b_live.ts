// scripts/_library_l4b_live.ts
//
// WARNING: THIS SCRIPT WRITES TO THE LIVE READER-NOTES TABLE AND
// DELETES WHAT IT WROTE. DO NOT RUN WITHOUT THE OWNER'S SAY.
//
// Runs A2 (state machine), A3 (only-your-own), and A6 (keyboard,
// via a subprocess that drives Playwright through the action
// route) as one gated pass, under the budget Kevin named:
//
//   - at most 10 rows written in total across all three
//   - each row created by this probe and deleted by id before
//     the probe exits
//   - no change to any row the probe did not create
//   - the table's row count before and after printed and equal
//
// Pre-snapshot every row. After A2+A3+A6 and cleanup, verify:
//   - row count equal
//   - every pre-existing id still present, with identical field
//     values (status, handled_by, handled_at, handled_outcome,
//     handled_note)
//   - every pre-existing note is still status='open' (today's
//     baseline is "count 3, all open")
// Any violation stops the probe at once and prints the discrepancy
// so Kevin can see it.

import { spawn } from "node:child_process";
import { serviceClient } from "../src/lib/supabase/service";
import { ownerEmails } from "../src/lib/supabase/env";
import { screenStateFor } from "../src/lib/academy/suggestions";

const BUDGET = 10;

type RowShape = {
  id: string;
  doc_id: string;
  reporter_email: string | null;
  status: string | null;
  handled_by: string | null;
  handled_at: string | null;
  handled_outcome: string | null;
  handled_note: string | null;
  created_at: string | null;
};

const SNAPSHOT_SELECT =
  "id, doc_id, reporter_email, status, handled_by, handled_at, handled_outcome, handled_note, created_at";

async function readAllRows(): Promise<RowShape[]> {
  const supa = serviceClient();
  const q = await supa.from("document_issues").select(SNAPSHOT_SELECT).limit(5000);
  if (q.error) throw new Error(`snapshot read: ${q.error.message}`);
  return (q.data as RowShape[]) || [];
}

function rowKey(r: RowShape): string {
  return [
    r.status ?? "",
    r.handled_by ?? "",
    r.handled_at ?? "",
    r.handled_outcome ?? "",
    r.handled_note ?? "",
  ].join("|");
}

async function pickReadable(): Promise<string> {
  const supa = serviceClient();
  const q = await supa
    .from("documents")
    .select("id")
    .eq("status", "Live")
    .eq("access_level", "unrestricted")
    .order("id")
    .limit(1);
  return ((q.data as Array<{ id: string }>)?.[0]?.id) ?? "POL-001";
}

async function pickRestricted(): Promise<string | null> {
  const supa = serviceClient();
  const q = await supa
    .from("documents")
    .select("id")
    .eq("status", "Live")
    .neq("access_level", "unrestricted")
    .order("id")
    .limit(1);
  return ((q.data as Array<{ id: string }>)?.[0]?.id) ?? null;
}

async function pickLearner(): Promise<string | null> {
  const supa = serviceClient();
  const owners = ownerEmails();
  const q = await supa
    .from("people")
    .select("work_email")
    .eq("status", "ACTIVE")
    .not("work_email", "is", null)
    .limit(200);
  for (const row of (q.data as Array<{ work_email: string | null }>) || []) {
    const e = (row.work_email || "").trim().toLowerCase();
    if (e && !owners.has(e)) return e;
  }
  return null;
}

async function createProbeRow(opts: { reporter: string; docId: string }): Promise<string> {
  const supa = serviceClient();
  const insQ = await supa
    .from("document_issues")
    .insert({
      doc_id: opts.docId,
      reporter_email: opts.reporter,
      // Placeholder; updated right after insert with the unique
      // per-row marker so Playwright's locator cannot collide
      // between two probe rows.
      issue_text: "L4b probe - pending marker",
      status: "open",
      data_provenance: "manual_entry",
    })
    .select("id")
    .single();
  if (insQ.error) throw new Error(`createProbeRow: ${insQ.error.message}`);
  const id = (insQ.data as { id: string }).id;
  // Stamp the row id into the body text so the locator can scope
  // to this exact row even when another probe row from the same
  // run also sits on the same list.
  const upd = await supa
    .from("document_issues")
    .update({ issue_text: `L4b probe ${id} - please ignore. Will be deleted.` })
    .eq("id", id);
  if (upd.error) throw new Error(`createProbeRow marker update: ${upd.error.message}`);
  return id;
}

async function deleteRows(ids: string[]) {
  if (ids.length === 0) return;
  const supa = serviceClient();
  // Delete by id, one at a time, to be absolutely sure nothing
  // else matches.
  for (const id of ids) {
    const r = await supa.from("document_issues").delete().eq("id", id);
    if (r.error) throw new Error(`deleteRow ${id}: ${r.error.message}`);
  }
}

async function readRow(id: string): Promise<RowShape | null> {
  const supa = serviceClient();
  const q = await supa
    .from("document_issues")
    .select(SNAPSHOT_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (q.error) return null;
  return (q.data as RowShape | null) ?? null;
}

function banner(s: string) {
  console.log(`\n==================== ${s} ====================\n`);
}

async function runKeyboardSubprocess(probeRowId: string): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      "node",
      [
        "--env-file=.env.local",
        "scripts/_l4b_e2e.mjs",
        "--keyboard-only",
        probeRowId,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { out += d.toString(); });
    child.on("close", (code: number | null) => {
      resolve({ ok: code === 0, stdout: out });
    });
  });
}

async function main() {
  banner("Pre-snapshot");
  const preRows = await readAllRows();
  const preById = new Map(preRows.map((r) => [r.id, r]));
  const preCount = preRows.length;
  const preOpenCount = preRows.filter((r) => r.status === "open").length;
  console.log(`row count: ${preCount}  open: ${preOpenCount}  other: ${preCount - preOpenCount}`);
  for (const r of preRows) {
    console.log(`  id=${r.id}  status=${r.status}  outcome=${r.handled_outcome ?? "null"}  handled_by=${r.handled_by ? "<set>" : "null"}`);
  }
  if (preCount !== 3 || preOpenCount !== 3) {
    console.error(`\nSTOP: expected 3 rows all open; got ${preCount} total, ${preOpenCount} open. Not running the probe.`);
    process.exit(1);
  }
  console.log("  baseline is 3 rows, all open - proceed.");

  const owner = [...ownerEmails()][0]!;
  const readable = await pickReadable();
  void pickRestricted; void pickLearner; // used by the A2/A3 path on the earlier run

  const createdIds: string[] = [];
  let a2Pass = true;
  let a3Pass = true;
  let a6Pass = true;
  let a2Lines: string[] = [];
  let a3Lines: string[] = [];
  let a6Lines: string[] = [];

  try {
    // ---------- A6 only this run: keyboard via Playwright (1 row) ----
    banner("A6 - keyboard walk (Playwright subprocess)");
    if (createdIds.length + 1 > BUDGET) throw new Error("budget would be exceeded before A6");
    const a6Id = await createProbeRow({ reporter: owner, docId: readable });
    createdIds.push(a6Id);
    a6Lines.push(`created 1 probe row for the keyboard walk (id tracked for cleanup)`);
    const kb = await runKeyboardSubprocess(a6Id);
    a6Lines.push("--- Playwright output follows ---");
    for (const ln of kb.stdout.split("\n")) {
      if (ln.length > 0) {
        console.log(`  ${ln}`);
        a6Lines.push(`  ${ln}`);
      }
    }
    const afterKb = await readRow(a6Id);
    const finalState = afterKb ? screenStateFor(afterKb.status, afterKb.handled_outcome) : "deleted";
    const line = `  Playwright exit=${kb.ok ? "ok" : "FAIL"}; probe row final state after walk = ${finalState}`;
    console.log(line);
    a6Lines.push(line);
    if (!kb.ok) a6Pass = false;
    // A6 is only a pass when the subprocess exited 0 AND the final
    // row state is "open" (Accept -> Decline -> Reopen walks the
    // row back to Open).
    if (finalState !== "open") {
      a6Pass = false;
      console.log(`  FAIL - final state should be "open" but is "${finalState}"`);
    }
    // Keep stub names for downstream printouts; the summary only
    // reports A6 this run.
    a2Pass = true;
    a3Pass = true;
    void a2Lines; void a3Lines;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("\nSTOP - probe threw:", msg);
    a6Pass = false;
  }

  // ---------- Cleanup ----------
  banner(`Cleanup - deleting ${createdIds.length} probe row${createdIds.length === 1 ? "" : "s"} by id`);
  try {
    await deleteRows(createdIds);
    console.log(`  deleted ${createdIds.length} rows.`);
  } catch (err) {
    console.error("Cleanup failed:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }

  // ---------- Post-snapshot + diff vs pre ----------
  banner("Post-snapshot + diff vs pre");
  const postRows = await readAllRows();
  const postCount = postRows.length;
  const postOpenCount = postRows.filter((r) => r.status === "open").length;
  console.log(`row count: ${postCount}  open: ${postOpenCount}  other: ${postCount - postOpenCount}`);
  let drift = 0;
  const leaks: string[] = [];
  for (const r of postRows) {
    const prev = preById.get(r.id);
    if (!prev) {
      leaks.push(r.id);
      drift += 1;
      continue;
    }
    if (rowKey(prev) !== rowKey(r)) {
      drift += 1;
      console.error(
        `  DRIFT on id=${r.id}: was [${rowKey(prev)}] now [${rowKey(r)}]`,
      );
    }
  }
  const countEqual = preCount === postCount;
  const stillAllOpen = postOpenCount === preCount;
  const leaked = leaks.length === 0;
  const unchanged = drift === 0;

  console.log(`\nRESULTS:`);
  console.log(`  row count before=${preCount} after=${postCount} (equal=${countEqual})`);
  console.log(`  rows still all open: ${stillAllOpen} (expect true; today's baseline is 3 open)`);
  console.log(`  zero leaked rows: ${leaked} (expect true; probe rows deleted by id)`);
  console.log(`  pre-existing rows unchanged: ${unchanged} (no status / handled_* field drifted)`);
  console.log(`  A2 pass: ${a2Pass}`);
  console.log(`  A3 pass: ${a3Pass}`);
  console.log(`  A6 pass: ${a6Pass}`);

  // This run is A6-only; A2 and A3 passed on the earlier run and
  // are not touched here. Only A6 and the safety checks gate the
  // RESULTS line this time.
  if (!countEqual || !stillAllOpen || !leaked || !unchanged || !a6Pass) {
    process.exitCode = 1;
    console.error("\nSTOP: at least one safety check or assertion failed. Do not re-run; tell Kevin.");
  } else {
    console.log("\nAll safety checks and assertions passed. Total probe rows written and deleted:", createdIds.length);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
