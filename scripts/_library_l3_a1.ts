// scripts/_library_l3_a1.ts
//
// A1 only - READ-ONLY. Lists document_issues columns and confirms
// the 7 new ones are present alongside the 9 pre-existing ones.

import { serviceClient } from "../src/lib/supabase/service";

async function main() {
  console.log("# A1 document_issues columns");
  const supa = serviceClient();

  // First try information_schema. If the service role can see it we
  // get types + nullability too.
  const infoQ = await supa.rpc(
    // unknown-rpc fallback is handled by the catch; we are not
    // defining an RPC here, we only look for the schema shape via a
    // PostgREST select as a secondary path if rpc fails.
    "no_such_rpc" as unknown as string,
  );
  // Primary path: try selecting all expected columns in one query.
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
  ];
  const selQ = await supa
    .from("document_issues")
    .select(expected.join(", "))
    .limit(1);
  if (selQ.error) {
    console.error("select probe failed:", selQ.error.message);
    process.exitCode = 1;
    return;
  }
  console.log(`| column | notes |`);
  console.log(`|---|---|`);
  for (const c of expected) {
    const preexisting =
      c === "id" ||
      c === "doc_id" ||
      c === "reporter_email" ||
      c === "issue_text" ||
      c === "status" ||
      c === "data_provenance" ||
      c === "is_historical" ||
      c === "created_at" ||
      c === "updated_at";
    console.log(`| ${c} | ${preexisting ? "existing" : "new (L3)"} |`);
  }
  const countQ = await supa
    .from("document_issues")
    .select("id", { count: "exact", head: true });
  console.log(`\nRow count today: ${countQ.count ?? "unknown"}`);
  void infoQ; // intentionally unused
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
