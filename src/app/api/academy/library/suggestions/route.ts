// /api/academy/library/suggestions
//
// POST a reader's "Suggest an edit". Read-only app-access gate on
// /library, then the submit function enforces every content rule.
//
// Response shape, by outcome:
//   201  ok              - the suggestion was stored. The route
//                          returns no row - the reader does not
//                          need to see the id, and the owner's list
//                          is the only place suggestions leave.
//   400  bad_request     - JSON parse failed.
//   401  unauth          - no session.
//   404  not_found       - doc_not_found OR doc_not_readable. Both
//                          collapse to the same status + body so a
//                          reader cannot probe for restricted docs.
//   409  section_missing - section_key does not match a real section.
//   413  text_too_long   - issue_text or suggested_text over its cap.
//   422  text_empty      - empty issue_text.
//   429  rate_limited    - too many open suggestions recently.
//   500  server_error    - anything else.

import { NextRequest, NextResponse } from "next/server";
import { requireAppAccessApi } from "@/lib/gate";
import { submitSuggestionForEmail } from "@/lib/academy/suggestions";

export const dynamic = "force-dynamic";

type Body = {
  docId?: unknown;
  issueText?: unknown;
  sectionKey?: unknown;
  suggestedText?: unknown;
  // Deliberately ignored; reporter_email is the server's session email.
  reporterEmail?: unknown;
};

// Document-number pattern - two to six uppercase letters, a hyphen,
// three digits, an optional -XX..-XXXX suffix (POL-001, POL-001-ES,
// AGR-001, REC-101). Validate BEFORE any gate or lookup, so a bad
// shape never reaches isOpenedPath, never reaches the database, and
// never widens the attack surface by being used to build a path.
const DOC_ID_RE = /^[A-Z]{2,6}-\d{3}(?:-[A-Z]{2,4})?$/;

export async function POST(request: NextRequest) {
  // Static gate path. We do not build the gated path from request
  // input: /library/* is one opened prefix (src/lib/academy/access.ts)
  // and the per-document may-read check lives inside
  // submitSuggestionForEmail. Building the gate path from docId
  // would let a crafted input participate in the gate decision.
  const g = await requireAppAccessApi("/library");
  if (g instanceof Response) return g;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const body = (raw && typeof raw === "object" ? raw : {}) as Body;

  // Validate shape before any DB lookup. A docId that does not match
  // the document-number pattern is rejected as bad_request so no
  // query sees user-shaped input.
  const docIdRaw = typeof body.docId === "string" ? body.docId.trim() : "";
  if (!docIdRaw || !DOC_ID_RE.test(docIdRaw)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const docId = docIdRaw;

  const issueText = typeof body.issueText === "string" ? body.issueText : "";
  const sectionKey =
    typeof body.sectionKey === "string" && body.sectionKey.length > 0
      ? body.sectionKey
      : null;
  const suggestedText =
    typeof body.suggestedText === "string" && body.suggestedText.length > 0
      ? body.suggestedText
      : null;

  const r = await submitSuggestionForEmail({
    email: g.email,
    docId,
    issueText,
    sectionKey,
    suggestedText,
  });
  if (r.ok) {
    return NextResponse.json({ ok: true }, { status: 201 });
  }
  switch (r.error) {
    case "unauthenticated":
      return NextResponse.json({ error: "unauth" }, { status: 401 });
    case "doc_not_found":
    case "doc_not_readable":
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    case "section_not_in_doc":
      return NextResponse.json({ error: "section_missing" }, { status: 409 });
    case "text_empty":
      return NextResponse.json({ error: "text_empty" }, { status: 422 });
    case "text_too_long":
    case "suggested_too_long":
      return NextResponse.json({ error: "text_too_long" }, { status: 413 });
    case "rate_limited":
      return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    default:
      return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
