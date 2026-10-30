// /api/academy/sign
//
// Body: { requirementId, attestationId, typedName, timeSpentSeconds? }
//
// (The v1 route also accepted `attestationText`; v2 BUILDS the
// attestation sentence server-side via buildAttestationSentence from
// the requirement's document and obligation. Any client-supplied
// attestationText in the body is ignored.)
//
// The one route that lands a signature. Six server-side gates, all
// of which must pass, then an INSERT into academy_attestations that
// is idempotent by the client-supplied attestationId.
//
// GATES
//   1. Requirement belongs to the authenticated worker.
//   2. Not already satisfied - no existing attestation row.
//   3. Every approved question has >=1 correct attempt by this
//      worker for this requirement. Zero approved questions passes.
//   4. typedName matches the authenticated person's display_name
//      (case-insensitive, whitespace-trimmed).
//   5. The requirement is not waived.
//   6. R-AC23: the document has readable content (document_content.html
//      exists and is non-empty for the viewer's language, English
//      default). A document with no body text cannot be attested to.
//      No inline acknowledgement path is accepted - the guard state
//      is the only honest UI.
//
// IDEMPOTENCY - attestationId is client-generated. On PK conflict,
// return the existing row with 200 (person signed, response was lost).
//
// APPEND-ONLY - academy_attestations refuses UPDATE / DELETE /
// TRUNCATE on the service_role grant surface.

import { NextRequest, NextResponse } from "next/server";
import { requireAppAccessApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { resolveAcademyIdentity } from "@/lib/academy/identity";
import {
  buildAttestationSentence,
  moduleTitleForAttestation,
} from "@/lib/academy/attestation";
import { UUID_RE } from "@/lib/academy/module";

export const dynamic = "force-dynamic";

interface SignBody {
  requirementId?: unknown;
  attestationId?: unknown;
  typedName?: unknown;
  timeSpentSeconds?: unknown;
  // Deliberately ignored; v2 builds the sentence server-side.
  attestationText?: unknown;
}

function normName(s: string): string {
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export async function POST(request: NextRequest) {
  const g = await requireAppAccessApi("/academy/read");
  if (g instanceof Response) return g;

  let body: SignBody;
  try {
    body = (await request.json()) as SignBody;
  } catch {
    return NextResponse.json(
      { error: "bad_request", detail: "invalid JSON body" },
      { status: 400 }
    );
  }
  const requirementId = body.requirementId;
  const attestationId = body.attestationId;
  const typedName = body.typedName;
  const timeSpentSecondsRaw = body.timeSpentSeconds;

  if (typeof requirementId !== "string" || !UUID_RE.test(requirementId)) {
    return NextResponse.json(
      { error: "bad_request", detail: "requirementId must be a UUID" },
      { status: 400 }
    );
  }
  if (typeof attestationId !== "string" || !UUID_RE.test(attestationId)) {
    return NextResponse.json(
      {
        error: "bad_request",
        detail: "attestationId must be a client-generated UUID",
      },
      { status: 400 }
    );
  }
  if (typeof typedName !== "string" || typedName.trim().length === 0) {
    return NextResponse.json(
      { error: "bad_request", detail: "typedName is required" },
      { status: 400 }
    );
  }
  const timeSpentSeconds = Number.isFinite(Number(timeSpentSecondsRaw))
    ? Math.max(0, Math.floor(Number(timeSpentSecondsRaw)))
    : null;

  const supa = serviceClient();

  let identity;
  try {
    identity = await resolveAcademyIdentity(g.email, { supa });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[api/academy/sign] resolve threw:", msg);
    return NextResponse.json({ error: "server_error", scope: "identity" }, { status: 500 });
  }
  if (!identity) {
    return NextResponse.json({ error: "no_roster_row" }, { status: 404 });
  }
  if (!identity.displayName) {
    return NextResponse.json(
      {
        error: "server_error",
        scope: "identity_no_name",
        detail: "authenticated identity has no display_name; cannot verify typed name",
      },
      { status: 500 }
    );
  }

  // ─── Gate 1: requirement belongs to the authenticated worker ───
  const reqQ = await supa
    .from("academy_requirements")
    .select(
      "requirement_id, worker_id, person_id, doc_id, obligation_key, doc_version, waived_at"
    )
    .eq("requirement_id", requirementId)
    .eq("worker_id", identity.workerId)
    .maybeSingle();
  if (reqQ.error) {
    console.error("[api/academy/sign] requirement lookup:", reqQ.error.message);
    return NextResponse.json({ error: "server_error", scope: "gate1" }, { status: 500 });
  }
  if (!reqQ.data) {
    return NextResponse.json(
      { error: "gate_failed", gate: 1, detail: "requirement not found for this worker" },
      { status: 404 }
    );
  }
  type ReqRow = {
    requirement_id: string;
    worker_id: string;
    person_id: string | null;
    doc_id: string;
    obligation_key: string;
    doc_version: string | number | null;
    waived_at: string | null;
  };
  const req = reqQ.data as ReqRow;

  // ─── Gate 5: requirement not waived ───
  if (req.waived_at != null) {
    return NextResponse.json(
      {
        error: "gate_failed",
        gate: 5,
        detail: "requirement is waived; signature is not required",
      },
      { status: 409 }
    );
  }

  // ─── Gate 6: R-AC23 - the document has readable content ───
  // A document with no document_content row (or an empty html body)
  // cannot be attested to; the Reader renders the guard state and
  // never surfaces a Sign control for it. This gate stands even if
  // a legacy client somehow POSTs to this route - the server is the
  // boundary. No inline acknowledgement path is accepted.
  const contentQ = await supa
    .from("document_content")
    .select("html")
    .eq("doc_id", req.doc_id)
    .eq("lang", "en")
    .maybeSingle();
  if (contentQ.error) {
    console.error("[api/academy/sign] content lookup:", contentQ.error.message);
    return NextResponse.json({ error: "server_error", scope: "gate6" }, { status: 500 });
  }
  const html = (contentQ.data as { html: string | null } | null)?.html ?? "";
  // "readable" = non-empty trimmed html with some non-tag text in it.
  // Strips tags, counts non-whitespace characters. 20 is a generous
  // floor: the shortest real document section runs well past that.
  const strippedLen = html.replace(/<[^>]*>/g, "").replace(/\s+/g, "").length;
  if (strippedLen < 20) {
    return NextResponse.json(
      {
        error: "gate_failed",
        gate: 6,
        detail:
          "document has no readable content; signature is refused per R-AC23. The reader renders the guard state instead.",
        doc_id: req.doc_id,
      },
      { status: 409 }
    );
  }

  // ─── Gate 2: not already satisfied ───
  const existingQ = await supa
    .from("academy_attestations")
    .select(
      "attestation_id, worker_id, doc_id, obligation_key, doc_version, typed_name, signed_at, attempts_count, time_spent_seconds, certificate_serial, source, attestation_text"
    )
    .eq("worker_id", identity.workerId)
    .eq("requirement_id", requirementId)
    .maybeSingle();
  if (existingQ.error) {
    console.error("[api/academy/sign] existing lookup:", existingQ.error.message);
    return NextResponse.json({ error: "server_error", scope: "gate2" }, { status: 500 });
  }
  if (existingQ.data) {
    const existingData = existingQ.data as { attestation_id: string; certificate_serial: string | null };
    if (existingData.attestation_id === attestationId) {
      return NextResponse.json({
        ok: true,
        idempotent: true,
        attestation: existingQ.data,
      });
    }
    return NextResponse.json(
      {
        error: "gate_failed",
        gate: 2,
        detail: "already signed - existing attestation does not match the client's UUID",
        existing_attestation_id: existingData.attestation_id,
        existing_certificate_serial: existingData.certificate_serial,
      },
      { status: 409 }
    );
  }

  // ─── Gate 3: every approved question has >=1 correct attempt ───
  const [approvedQ, correctAttemptsQ] = await Promise.all([
    supa
      .from("academy_questions")
      .select("question_id")
      .eq("doc_id", req.doc_id)
      .eq("obligation_key", req.obligation_key)
      .eq("doc_version", req.doc_version)
      .eq("status", "approved"),
    supa
      .from("academy_check_attempts")
      .select("question_id")
      .eq("worker_id", identity.workerId)
      .eq("requirement_id", requirementId)
      .eq("correct", true),
  ]);
  if (approvedQ.error) {
    console.error("[api/academy/sign] approved questions:", approvedQ.error.message);
    return NextResponse.json({ error: "server_error", scope: "gate3_questions" }, { status: 500 });
  }
  if (correctAttemptsQ.error) {
    console.error("[api/academy/sign] correct attempts:", correctAttemptsQ.error.message);
    return NextResponse.json({ error: "server_error", scope: "gate3_attempts" }, { status: 500 });
  }
  const approvedIds = ((approvedQ.data as Array<{ question_id: number }>) || []).map(
    (r) => r.question_id
  );
  const correctIds = new Set(
    ((correctAttemptsQ.data as Array<{ question_id: number }>) || []).map((r) => r.question_id)
  );
  const missing = approvedIds.filter((id) => !correctIds.has(id));
  if (missing.length > 0) {
    return NextResponse.json(
      {
        error: "gate_failed",
        gate: 3,
        detail: "not every approved question has a correct attempt yet",
        missing_question_ids: missing,
        approved_count: approvedIds.length,
        correct_count: correctIds.size,
      },
      { status: 409 }
    );
  }

  // ─── Gate 4: typed name matches display_name ───
  if (normName(typedName) !== normName(identity.displayName)) {
    return NextResponse.json(
      {
        error: "gate_failed",
        gate: 4,
        detail: "typed name does not match your account name",
      },
      { status: 422 }
    );
  }

  // ─── All gates passed. Build the attestation sentence server-side
  //     from the requirement's document + obligation. ───
  const [docQ, oblQ] = await Promise.all([
    supa
      .from("documents")
      .select("id, title, version")
      .eq("id", req.doc_id)
      .maybeSingle(),
    supa
      .from("academy_obligations")
      .select("doc_id, obligation_key, source_section, description")
      .eq("doc_id", req.doc_id)
      .eq("obligation_key", req.obligation_key)
      .maybeSingle(),
  ]);
  if (docQ.error) {
    console.error("[api/academy/sign] document lookup:", docQ.error.message);
    return NextResponse.json({ error: "server_error", scope: "doc_for_text" }, { status: 500 });
  }
  if (oblQ.error) {
    console.error("[api/academy/sign] obligation lookup:", oblQ.error.message);
    return NextResponse.json({ error: "server_error", scope: "obl_for_text" }, { status: 500 });
  }
  const docRow = docQ.data as { id: string; title: string | null; version: string | number | null } | null;
  const oblRow = oblQ.data as { source_section: string | null; description: string | null } | null;
  // moduleTitleForAttestation handles both cases: single-section
  // obligations still get the section heading; multi-section ones
  // get the module name derived from the obligation description's
  // lead clause. Falls back to empty when neither path can produce
  // a safe title, and buildAttestationSentence then emits the
  // document-only form.
  const moduleTitle = moduleTitleForAttestation({
    sourceSection: oblRow?.source_section,
    description: oblRow?.description,
  });
  const attestationText = buildAttestationSentence({
    displayName: identity.displayName,
    moduleTitle: moduleTitle || null,
    documentTitle: docRow?.title || req.doc_id,
    version: req.doc_version ?? docRow?.version ?? null,
  });

  // Read attempt count + progress time for the record.
  const [totalAttemptsQ, progressQ] = await Promise.all([
    supa
      .from("academy_check_attempts")
      .select("*", { count: "exact", head: true })
      .eq("worker_id", identity.workerId)
      .eq("requirement_id", requirementId),
    supa
      .from("academy_module_progress")
      .select("time_spent_seconds")
      .eq("worker_id", identity.workerId)
      .eq("requirement_id", requirementId)
      .maybeSingle(),
  ]);
  if (totalAttemptsQ.error) {
    console.error("[api/academy/sign] total attempts:", totalAttemptsQ.error.message);
    return NextResponse.json({ error: "server_error", scope: "attempts_count" }, { status: 500 });
  }
  const attemptsCount = totalAttemptsQ.count ?? 0;
  const progressRow = progressQ.data as { time_spent_seconds: number | null } | null;
  const progressTime = progressRow?.time_spent_seconds ?? 0;
  const clientTime = timeSpentSeconds ?? 0;
  const timeToStore = Math.max(progressTime, clientTime);

  // INSERT the attestation. attestation_id is client-supplied for
  // idempotency; certificate_serial + signed_at take defaults.
  const insertRow = {
    attestation_id: attestationId,
    worker_id: identity.workerId,
    person_id: identity.personId,
    requirement_id: requirementId,
    doc_id: req.doc_id,
    obligation_key: req.obligation_key,
    doc_version: req.doc_version,
    typed_name: typedName,
    attestation_text: attestationText,
    attempts_count: attemptsCount,
    time_spent_seconds: timeToStore,
    source: "intranet",
  };

  const insQ = await supa
    .from("academy_attestations")
    .insert(insertRow)
    .select(
      "attestation_id, worker_id, doc_id, obligation_key, doc_version, typed_name, signed_at, attempts_count, time_spent_seconds, certificate_serial, source, attestation_text"
    )
    .single();

  if (insQ.error) {
    const errCode = (insQ.error as { code?: string }).code;
    if (errCode === "23505") {
      // Idempotent retry: PK conflict means the client resent a
      // request that already persisted. Return the existing row.
      const refetch = await supa
        .from("academy_attestations")
        .select(
          "attestation_id, worker_id, doc_id, obligation_key, doc_version, typed_name, signed_at, attempts_count, time_spent_seconds, certificate_serial, source, attestation_text"
        )
        .eq("attestation_id", attestationId)
        .maybeSingle();
      if (refetch.data) {
        return NextResponse.json({ ok: true, idempotent: true, attestation: refetch.data });
      }
    }
    console.error("[api/academy/sign] insert:", insQ.error.message);
    return NextResponse.json(
      { error: "server_error", scope: "insert", detail: insQ.error.message },
      { status: 500 }
    );
  }

  // Update progress with final time_spent (best-effort).
  await supa
    .from("academy_module_progress")
    .update({
      last_seen_at: new Date().toISOString(),
      time_spent_seconds: timeToStore ?? 0,
    })
    .eq("worker_id", identity.workerId)
    .eq("requirement_id", requirementId);

  return NextResponse.json({ ok: true, idempotent: false, attestation: insQ.data });
}
