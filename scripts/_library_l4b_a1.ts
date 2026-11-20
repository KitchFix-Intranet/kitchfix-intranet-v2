// scripts/_library_l4b_a1.ts
//
// A1 only - READ-ONLY. Confirms the `handled_note` column exists
// on `public.document_issues` and lists every column the L4b code
// paths will reach.
//
// This is a probe, not a writer. It makes a single-row select of
// the expected column set and returns ok if PostgREST accepts it.
// A missing column surfaces as an error naming the column.

import { serviceClient } from "../src/lib/supabase/service";

async function main() {
  console.log("# A1 document_issues columns + handled_note");
  const supa = serviceClient();
  const expected = [
    "id",
    "doc_id",
    "reporter_email",
    "issue_text",
    "status",
    "data_provenance",
    "is_historical",
    "created_at",
    "updated_at",
    "section_key",
    "section_title",
    "doc_version",
    "suggested_text",
    "handled_by",
    "handled_at",
    "handled_outcome",
    "handled_note",
  ];
  const q = await supa
    .from("document_issues")
    .select(expected.join(", "))
    .limit(1);
  if (q.error) {
    console.error("MISSING OR UNREADABLE:", q.error.message);
    process.exitCode = 1;
    return;
  }
  for (const c of expected) {
    const note = c === "handled_note" ? "NEW (L4b)" : "existing or L3";
    console.log(`  present - ${c} (${note})`);
  }
  const countQ = await supa
    .from("document_issues")
    .select("id", { count: "exact", head: true });
  console.log(`\nRow count today: ${countQ.count ?? "unknown"}`);
  // Status distribution so we know what the June rows look like now.
  const statusQ = await supa
    .from("document_issues")
    .select("status, handled_outcome, created_at")
    .order("created_at", { ascending: false })
    .limit(10);
  if (!statusQ.error) {
    console.log("\nLatest rows (shape only, no text printed):");
    type R = { status: string | null; handled_outcome: string | null; created_at: string | null };
    for (const r of (statusQ.data as R[]) ?? []) {
      console.log(`  status=${r.status ?? "null"}  handled_outcome=${r.handled_outcome ?? "null"}  at=${r.created_at ?? "null"}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
