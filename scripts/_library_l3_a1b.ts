// scripts/_library_l3_a1b.ts
//
// A1b - READ-ONLY. Additional details about document_issues: which
// check constraints exist (status enum), which index Kevin applied,
// and the shape of the 2 existing rows (without printing their text,
// because the repo is public).

import { serviceClient } from "../src/lib/supabase/service";

async function main() {
  const supa = serviceClient();

  console.log("# A1b constraints + indexes + row shape");
  // Status enum coverage - what status values are already in use.
  const sQ = await supa
    .from("document_issues")
    .select("status, data_provenance, created_at, section_key, section_title, doc_version, handled_outcome")
    .limit(10);
  if (sQ.error) {
    console.error("[a1b] row probe failed:", sQ.error.message);
    process.exit(1);
  }
  type R = {
    status: string | null;
    data_provenance: string | null;
    created_at: string | null;
    section_key: string | null;
    section_title: string | null;
    doc_version: string | null;
    handled_outcome: string | null;
  };
  const rows = (sQ.data as R[]) || [];
  console.log(`| idx | status | data_provenance | has section_key | has section_title | has doc_version | handled_outcome |`);
  console.log(`|---|---|---|---|---|---|---|`);
  rows.forEach((r, i) => {
    console.log(
      `| ${i} | ${r.status ?? "null"} | ${r.data_provenance ?? "null"} | ${r.section_key ? "yes" : "no"} | ${r.section_title ? "yes" : "no"} | ${r.doc_version ? "yes" : "no"} | ${r.handled_outcome ?? "null"} |`,
    );
  });

  // Try to read the status check constraint directly from pg_constraint
  // via supabase; if the service-role cannot see pg_constraint we fall
  // back to writing a bogus row with each candidate status and seeing
  // which refuses. (We only do this on the probe, and clean up.)
  const cheQ = await supa
    .from("pg_constraint" as unknown as string)
    .select("conname, pg_get_constraintdef(oid)")
    .limit(5);
  if (!cheQ.error) {
    console.log("\n(pg_constraint is readable; check constraints can be dumped out of band.)");
  } else {
    console.log("\n(pg_constraint not readable to service role; status enum is inferred from documented rule only.)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
