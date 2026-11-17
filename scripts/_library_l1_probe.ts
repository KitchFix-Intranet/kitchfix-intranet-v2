// scripts/_library_l1_probe.ts
//
// Library train L1 probe. READ-ONLY. Prints one table.
//
// Usage (from the worktree, with .env.local populated):
//
//   node --env-file=.env.local --import tsx scripts/_library_l1_probe.ts
//
// Picks one email of each viewer kind programmatically:
//   owner         - an OWNER_EMAILS entry
//   library_admin - a non-owner with library_admin or academy_admin
//                   in academy_grants
//   region_lead   - a non-owner in academy_region_leads with no
//                   admin grant
//   learner       - a non-owner on the ACTIVE roster with no admin
//                   grant and no region-lead row
//
// Under Kevin's L1 ruling (2026-11-17) only the owner is reads_all;
// library_admin, region_lead and learner are all reads_unrestricted.
// Expected, against today's database:
//   owner:          82 / 82 / 82, restricted doc opens, unknown 404
//   library_admin:  70 / 70 / 70, restricted doc kept_for, unknown 404
//   region_lead:    70 / 70 / 70, restricted doc kept_for, unknown 404
//   learner:        70 / 70 / 70, restricted doc kept_for, unknown 404
//
// Picks one restricted and one unrestricted docId from today's
// `documents` table. Then calls the three loaders for each viewer
// and prints a markdown table. The probe writes nothing. Emails are
// never printed (the repo is public): the table is keyed on the
// viewer-kind label, not the email.

import { serviceClient } from "../src/lib/supabase/service";
import { ownerEmails } from "../src/lib/supabase/env";
import { loadLibrary, loadLibraryIndex } from "../src/lib/academy/library";
import { loadDocument } from "../src/lib/academy/document";

type ViewerKind = "owner" | "library_admin" | "region_lead" | "learner";

const UNKNOWN_DOC_ID = "DOES-NOT-EXIST-9999";

function pad(s: string | number, n: number, right = false): string {
  const t = String(s);
  if (t.length >= n) return t;
  const fill = " ".repeat(n - t.length);
  return right ? fill + t : t + fill;
}

async function pickEmails(
  supa: ReturnType<typeof serviceClient>,
): Promise<Record<ViewerKind, string | null>> {
  const owners = new Set([...ownerEmails()]);
  const ownerOne = [...owners][0] ?? null;

  const grantsQ = await supa
    .from("academy_grants")
    .select("email, grant_type")
    .in("grant_type", ["library_admin", "academy_admin"]);
  const grantEmails = new Set(
    ((grantsQ.data as Array<{ email: string }>) || [])
      .map((r) => String(r.email || "").toLowerCase())
      .filter((e) => e && !owners.has(e)),
  );
  const libraryAdminOne = [...grantEmails][0] ?? null;

  const regionQ = await supa.from("academy_region_leads").select("email");
  const regionEmailsAll = new Set(
    ((regionQ.data as Array<{ email: string }>) || [])
      .map((r) => String(r.email || "").toLowerCase())
      .filter((e) => e && !owners.has(e)),
  );
  const regionEmailsNoGrant = [...regionEmailsAll].filter(
    (e) => !grantEmails.has(e),
  );
  const regionLeadOne = regionEmailsNoGrant[0] ?? null;

  const peopleQ = await supa
    .from("people")
    .select("work_email")
    .eq("status", "ACTIVE")
    .not("work_email", "is", null)
    .limit(500);
  const excluded = new Set<string>([
    ...owners,
    ...grantEmails,
    ...regionEmailsAll,
  ]);
  const learnerOne =
    ((peopleQ.data as Array<{ work_email: string | null }>) || [])
      .map((r) => String(r.work_email || "").toLowerCase())
      .find((e) => !!e && !excluded.has(e) && e.endsWith("@kitchfix.com")) ??
    null;

  return {
    owner: ownerOne,
    library_admin: libraryAdminOne,
    region_lead: regionLeadOne,
    learner: learnerOne,
  };
}

async function pickDocs(
  supa: ReturnType<typeof serviceClient>,
): Promise<{ restricted: string | null; unrestricted: string | null }> {
  const q = await supa
    .from("documents")
    .select("id, access_level")
    .eq("status", "Live")
    .not("shelf", "is", null);
  const rows =
    (q.data as Array<{ id: string; access_level: string | null }>) || [];
  const restricted = rows.find((r) => r.access_level === "restricted")?.id ?? null;
  const unrestricted =
    rows.find((r) => r.access_level === "unrestricted")?.id ?? null;
  return { restricted, unrestricted };
}

async function main() {
  const supa = serviceClient();
  const [emails, docs] = await Promise.all([pickEmails(supa), pickDocs(supa)]);

  console.log("# Library L1 probe");
  console.log(
    "\nPicked docs: restricted=",
    docs.restricted ?? "(none)",
    " unrestricted=",
    docs.unrestricted ?? "(none)",
  );
  console.log(
    "Picked viewer kinds: ",
    Object.entries(emails)
      .map(([k, v]) => `${k}=${v ? "found" : "MISSING"}`)
      .join(", "),
    "\n",
  );

  const header =
    "| " +
    [
      pad("viewer", 16),
      pad("find.totalDocs", 14),
      pad("shelves.totalDocs", 17),
      pad("shelves.count sum", 17),
      pad("restricted open", 24),
      pad("unrestricted open", 17),
      pad("unknown open", 12),
    ].join(" | ") +
    " |";
  const rule =
    "|-" +
    [
      "-".repeat(16),
      "-".repeat(14),
      "-".repeat(17),
      "-".repeat(17),
      "-".repeat(24),
      "-".repeat(17),
      "-".repeat(12),
    ].join("-|-") +
    "-|";
  console.log(header);
  console.log(rule);

  for (const kind of [
    "owner",
    "library_admin",
    "region_lead",
    "learner",
  ] as ViewerKind[]) {
    const email = emails[kind];
    if (!email) {
      console.log(
        "| " +
          pad(kind, 16) +
          " | " +
          pad("SKIP (no email in DB)", 14 + 3 + 17 + 3 + 17 + 3 + 24 + 3 + 17 + 3 + 12, false) +
          " |",
      );
      continue;
    }
    const [idx, lib] = await Promise.all([
      loadLibraryIndex(email),
      loadLibrary(email),
    ]);
    const idxTotal = idx.ok ? idx.totalDocs : `ERR:${idx.error}`;
    let shelvesTotal: string | number = "n/a";
    let countSum: string | number = "n/a";
    if (lib.ok) {
      shelvesTotal = lib.totalDocs;
      countSum = lib.shelves.reduce((a, s) => a + s.count, 0);
    } else {
      shelvesTotal = `ERR:${lib.error}`;
    }

    let restrictedResult = "n/a";
    if (docs.restricted) {
      const r = await loadDocument(email, docs.restricted);
      if (r.ok) restrictedResult = "ok(fields)";
      else if (r.status === 403) restrictedResult = `kept_for(id=${r.docId})`;
      else restrictedResult = `status:${r.status}`;
    }

    let unrestrictedResult = "n/a";
    if (docs.unrestricted) {
      const r = await loadDocument(email, docs.unrestricted);
      if (r.ok) unrestrictedResult = "ok(fields)";
      else if (r.status === 403) unrestrictedResult = `kept_for`;
      else unrestrictedResult = `status:${r.status}`;
    }

    const u = await loadDocument(email, UNKNOWN_DOC_ID);
    const unknownResult = u.ok ? "ok" : `status:${u.status}`;

    console.log(
      "| " +
        [
          pad(kind, 16),
          pad(idxTotal, 14, true),
          pad(shelvesTotal, 17, true),
          pad(countSum, 17, true),
          pad(restrictedResult, 24),
          pad(unrestrictedResult, 17),
          pad(unknownResult, 12),
        ].join(" | ") +
        " |",
    );
  }

  // A4 support: for owner viewer on three chosen doc_ids, prove the
  // loadDocument payload still carries the full doc-body shape (no
  // keys removed, access_level never surfaced). The page component
  // is the only transform from payload -> HTML; payload identity is
  // the strongest proof available without a browser.
  if (emails.owner) {
    const chosen = [
      docs.unrestricted,
      docs.restricted,
      "POST-001-ES",
    ].filter((x): x is string => Boolean(x));
    console.log("\nA4: owner viewer, loadDocument payload shape for three docs:");
    for (const docId of chosen) {
      const r = await loadDocument(emails.owner, docId);
      if (!r.ok) {
        console.log(`  ${docId}: NOT OK status=${r.status}`);
        continue;
      }
      const docKeys = Object.keys(r.doc).sort().join(",");
      console.log(
        `  ${docId}: ok, doc.keys=${docKeys}, has access_level=${"access_level" in r.doc}, has title=${!!r.doc.title}, has summary_or_null=${"summary" in r.doc}`,
      );
    }
  }

  // A3 support: show the keys and docId that leak into a learner's
  // response payload for a restricted doc. The restricted branch of
  // DocumentResult carries only {ok,status,error,docId} - a title /
  // card_line / summary cannot leak because none of those fields
  // exist on this variant. Print the object keys to prove the shape.
  if (docs.restricted && emails.learner) {
    const r = await loadDocument(emails.learner, docs.restricted);
    console.log("\nA3: learner + restricted doc, payload keys + docId check:");
    console.log("  payload.keys       =", Object.keys(r).sort().join(","));
    console.log("  has .docId         =", "docId" in r);
    console.log("  has .title         =", "title" in r);
    console.log("  has .card_line     =", "card_line" in r);
    console.log("  has .summary       =", "summary" in r);
    console.log(
      "  docId value        =",
      "docId" in r ? (r as { docId: string }).docId : "(n/a)",
    );
  }
}

main().catch((err) => {
  const msg = err && typeof err === "object" && "stack" in err ? (err as { stack?: string }).stack : String(err);
  console.error("probe failed:", msg);
  process.exit(1);
});
