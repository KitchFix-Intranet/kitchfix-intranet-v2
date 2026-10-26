// src/lib/academy/document.ts
//
// Loader for /library/[docId] - the read-only document viewer.
// Returns the document's metadata, pre-rendered English HTML, and
// the viewer's Academy status for this doc (does it train them,
// have they signed it). Library documents are not requirements -
// reading one records nothing; this loader never writes.
//
// Live-only. A document that is not status='Live' resolves to
// ok:false 404 the same way a non-existent doc_id does; the Library
// gate is "a chef should be reading this now."
//
// Empty-content guard: 2 Live documents have no lang='en' content
// row today (POST-001-ES, POL-006-ES - Spanish-only postings). The
// loader returns ok:true but emptyContent:true so the viewer can
// render the "no readable content yet" state instead of a blank
// pane.

import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "@/lib/supabase/service";
import { resolveAcademyIdentity } from "./identity";

export type DocumentResult =
  | { ok: false; status: 404 | 500; error: string; detail?: string }
  | ({ ok: true } & DocumentBody);

export interface DocumentBody {
  viewer: {
    workerId: string | null;
    personId: string | null;
    displayName: string | null;
    onRoster: boolean;
    isSalaried: boolean;
  };
  doc: {
    id: string;
    title: string;
    doc_class: string | null;
    status: string;
    version: string | number | null;
    shelf: string | null;
    owner: string | null;
    approver: string | null;
    effective_date: string | null;
    last_reviewed: string | null;
    next_review: string | null;
    updated_at: string | null;
    card_line: string | null;
    summary: string | null;
  };
  // Pre-rendered HTML from document_content (lang='en'). Null +
  // emptyContent=true when no content row exists.
  content_html: string | null;
  content_rendered_at: string | null;
  emptyContent: boolean;
  // Academy status for THIS viewer on THIS doc.
  // Reader route id if the viewer has an open requirement that
  // trains them on this doc (not yet signed); null otherwise.
  trainsYou: boolean;
  openRequirementId: string | number | null;
  // The viewer's most-recent attestation on this doc, if any.
  signedAttestation: {
    attestation_id: string | number;
    certificate_serial: string | null;
    signed_at: string | null;
    doc_version: string | number | null;
  } | null;
  // Does Spanish content exist for this doc_id? (POST-001 vs
  // POST-001-ES, etc.) Rendered as a hint next to the facts; the
  // Spanish toggle itself is a later train.
  languages: {
    hasEn: boolean;
    hasEs: boolean;
  };
}

function obligationTrainsViewer(applies_to: unknown, viewerIsSalaried: boolean): boolean {
  if (applies_to == null) return true;
  if (typeof applies_to === "string") return applies_to === "company-wide";
  if (typeof applies_to !== "object") return true;
  const wc = (applies_to as { worker_class?: string }).worker_class;
  if (wc == null) return true;
  if (wc === "all") return true;
  if (wc === "salaried") return !!viewerIsSalaried;
  if (wc === "hourly") return !viewerIsSalaried;
  return true;
}

export async function loadDocument(
  email: string,
  docId: string,
  supaIn?: SupabaseClient,
): Promise<DocumentResult> {
  const supa = supaIn || serviceClient();

  const docQ = await supa
    .from("documents")
    .select(
      "id, title, doc_class, status, version, shelf, owner, approver, effective_date, last_reviewed, next_review, updated_at, card_line, summary",
    )
    .eq("id", docId)
    .maybeSingle();
  if (docQ.error) {
    console.error("[academy/loadDocument] document lookup:", docQ.error.message);
    return { ok: false, status: 500, error: "server_error" };
  }
  if (!docQ.data) {
    return { ok: false, status: 404, error: "not_found" };
  }
  type DocRow = {
    id: string;
    title: string | null;
    doc_class: string | null;
    status: string;
    version: string | number | null;
    shelf: string | null;
    owner: string | null;
    approver: string | null;
    effective_date: string | null;
    last_reviewed: string | null;
    next_review: string | null;
    updated_at: string | null;
    card_line: string | null;
    summary: string | null;
  };
  const docRow = docQ.data as DocRow;

  // Live-only. GOTCHA 17 - the status value is title-case; match it
  // exactly. Non-Live docs 404 (indistinguishable from "doesn't
  // exist" so the catalog surface cannot be used to probe which
  // docs are in build).
  if (docRow.status !== "Live") {
    return { ok: false, status: 404, error: "not_found" };
  }

  // Identity (viewer). Legitimately null for anyone off the roster;
  // the viewer still gets to read the document, they just do not
  // get a "trains you" marker or signed-attestation line.
  let identity: Awaited<ReturnType<typeof resolveAcademyIdentity>> = null;
  try {
    identity = await resolveAcademyIdentity(email, { supa });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[academy/loadDocument] identity resolve threw:", msg);
    identity = null;
  }

  // Content, obligations-for-this-doc, viewer's attestations-for-this-doc,
  // sibling docs for language detection. All parallel; all small.
  const [contentQ, obQ, attQ, langDocQ] = await Promise.all([
    supa
      .from("document_content")
      .select("html, rendered_at")
      .eq("doc_id", docId)
      .eq("lang", "en")
      .maybeSingle(),
    supa
      .from("academy_obligations")
      .select("obligation_key, applies_to")
      .eq("doc_id", docId),
    identity
      ? supa
          .from("academy_attestations")
          .select("attestation_id, requirement_id, doc_id, doc_version, signed_at, certificate_serial")
          .eq("worker_id", identity.workerId)
          .eq("doc_id", docId)
          .order("signed_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    // Sibling doc_ids: POL-006 vs POL-006-ES. We look at any doc whose
    // id matches `${docId}-ES` or `${docId}` prefix if this is itself
    // the -ES variant. Narrow probe - not an index into every doc.
    supa
      .from("documents")
      .select("id")
      .in("id", [docId, `${docId}-ES`, docId.replace(/-ES$/, "")])
      .eq("status", "Live"),
  ]);
  if (contentQ.error) {
    console.error("[academy/loadDocument] content lookup:", contentQ.error.message);
    return { ok: false, status: 500, error: "server_error" };
  }
  if (obQ.error) {
    console.error("[academy/loadDocument] obligations lookup:", obQ.error.message);
    return { ok: false, status: 500, error: "server_error" };
  }
  if (attQ.error) {
    console.error("[academy/loadDocument] attestations lookup:", attQ.error.message);
    // non-fatal; still render the document
  }
  if (langDocQ.error) {
    console.warn("[academy/loadDocument] language sibling lookup:", langDocQ.error.message);
  }

  type ContentRow = { html: string | null; rendered_at: string | null };
  type ObRow = { obligation_key: string; applies_to: unknown };
  type AttRow = {
    attestation_id: string | number;
    requirement_id: string | number | null;
    doc_id: string;
    doc_version: string | number | null;
    signed_at: string | null;
    certificate_serial: string | null;
  };
  type LangRow = { id: string };

  const contentRow = (contentQ.data as ContentRow | null) || null;
  const obs = (obQ.data as ObRow[]) || [];
  const att = (attQ.data as AttRow | null) || null;
  const langRows = (langDocQ.data as LangRow[]) || [];

  // Does this doc train the viewer? Scan obligations whose applies_to
  // matches the viewer's class. Mirror of library.ts's trains-you.
  const viewerIsSalaried = !!(identity && identity.isSalaried);
  let trainsYou = false;
  if (identity) {
    for (const ob of obs) {
      if (obligationTrainsViewer(ob.applies_to, viewerIsSalaried)) {
        trainsYou = true;
        break;
      }
    }
  }

  // Open requirement: viewer trains on this doc + has an unsigned
  // row. The Library's "On your to-do list" link needs a
  // requirement_id to deep-link into /academy/read/[reqId].
  let openRequirementId: string | number | null = null;
  if (identity && trainsYou && !att) {
    const reqQ = await supa
      .from("academy_requirements")
      .select("requirement_id")
      .eq("worker_id", identity.workerId)
      .eq("doc_id", docId)
      .is("waived_at", null)
      .order("due_date", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!reqQ.error && reqQ.data) {
      openRequirementId = (reqQ.data as { requirement_id: string | number }).requirement_id;
    }
  }

  // Language detection: is there a matching -ES sibling (or the EN
  // variant of this -ES doc)? Hint-only; a toggle arrives with the
  // Spanish train.
  const docIsES = docId.endsWith("-ES");
  const siblingIds = new Set(langRows.map((r) => r.id));
  const hasEn = docIsES ? siblingIds.has(docId.replace(/-ES$/, "")) : contentRow != null;
  const hasEs = docIsES ? true : siblingIds.has(`${docId}-ES`);

  return {
    ok: true,
    viewer: {
      workerId: identity?.workerId ?? null,
      personId: identity?.personId ?? null,
      displayName: identity?.displayName ?? null,
      onRoster: !!identity,
      isSalaried: viewerIsSalaried,
    },
    doc: {
      id: docRow.id,
      title: docRow.title || docRow.id,
      doc_class: docRow.doc_class,
      status: docRow.status,
      version: docRow.version,
      shelf: docRow.shelf,
      owner: docRow.owner,
      approver: docRow.approver,
      effective_date: docRow.effective_date,
      last_reviewed: docRow.last_reviewed,
      next_review: docRow.next_review,
      updated_at: docRow.updated_at,
      card_line: docRow.card_line,
      summary: docRow.summary,
    },
    content_html: contentRow?.html ?? null,
    content_rendered_at: contentRow?.rendered_at ?? null,
    emptyContent: contentRow == null,
    trainsYou,
    openRequirementId,
    signedAttestation: att
      ? {
          attestation_id: att.attestation_id,
          certificate_serial: att.certificate_serial,
          signed_at: att.signed_at,
          doc_version: att.doc_version,
        }
      : null,
    languages: { hasEn, hasEs },
  };
}
