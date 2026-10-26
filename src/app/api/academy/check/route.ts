// /api/academy/check
//
// Body: { requirementId, questionId, selectedOptionId }
//
// Grading happens HERE and only here. The route reads the question's
// correct_option_id in a query the client cannot inspect, compares
// server-side, records the attempt in academy_check_attempts (right
// or wrong, every time - spec 8), and returns { correct, explanation }
// where the explanation is for the SELECTED option, not all of them.
//
// Returning every explanation would leak the answer by process of
// elimination: the correct option's explanation is warm-and-affirms,
// the wrong ones are corrective. This route returns only the one
// the client picked.
//
// Unlimited attempts. No lockout, no cooldown, no attempt cap (spec 8).
// Every attempt is recorded. Wrong attempts are evidence, not failure.
//
// APPEND-ONLY - academy_check_attempts refuses UPDATE/DELETE/TRUNCATE.

import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { resolveAcademyIdentity } from "@/lib/academy/identity";
import { UUID_RE } from "@/lib/academy/module";

export const dynamic = "force-dynamic";

interface CheckBody {
  requirementId?: unknown;
  questionId?: unknown;
  selectedOptionId?: unknown;
}

interface OptionShape {
  id?: string;
  explanation?: string;
}

export async function POST(request: NextRequest) {
  const g = await requireOwnerApi();
  if (g instanceof Response) return g;

  let body: CheckBody;
  try {
    body = (await request.json()) as CheckBody;
  } catch {
    return NextResponse.json(
      { error: "bad_request", detail: "invalid JSON body" },
      { status: 400 }
    );
  }
  const requirementId = body.requirementId;
  const questionId = body.questionId;
  const selectedOptionId = body.selectedOptionId;
  if (typeof requirementId !== "string" || !UUID_RE.test(requirementId)) {
    return NextResponse.json(
      { error: "bad_request", detail: "requirementId must be a UUID" },
      { status: 400 }
    );
  }
  if (questionId == null || !Number.isFinite(Number(questionId))) {
    return NextResponse.json(
      { error: "bad_request", detail: "questionId must be a number" },
      { status: 400 }
    );
  }
  if (typeof selectedOptionId !== "string" || !selectedOptionId) {
    return NextResponse.json(
      { error: "bad_request", detail: "selectedOptionId must be a string" },
      { status: 400 }
    );
  }

  const supa = serviceClient();

  let identity;
  try {
    identity = await resolveAcademyIdentity(g.email, { supa });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[api/academy/check] resolve threw:", msg);
    return NextResponse.json({ error: "server_error", scope: "identity" }, { status: 500 });
  }
  if (!identity) {
    return NextResponse.json({ error: "no_roster_row" }, { status: 404 });
  }

  // Verify the requirement belongs to this viewer.
  const reqQ = await supa
    .from("academy_requirements")
    .select(
      "requirement_id, worker_id, person_id, doc_id, obligation_key, doc_version, waived_at"
    )
    .eq("requirement_id", requirementId)
    .eq("worker_id", identity.workerId)
    .maybeSingle();
  if (reqQ.error) {
    console.error("[api/academy/check] requirement lookup:", reqQ.error.message);
    return NextResponse.json({ error: "server_error", scope: "requirement" }, { status: 500 });
  }
  if (!reqQ.data) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
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

  // Load the question. Verify it belongs to the requirement's module.
  // SELECT correct_option_id + options here because THIS is the
  // grading site. correct_option_id is compared in memory and never
  // returned to the caller.
  const qQ = await supa
    .from("academy_questions")
    .select(
      "question_id, doc_id, obligation_key, doc_version, status, correct_option_id, options"
    )
    .eq("question_id", Number(questionId))
    .maybeSingle();
  if (qQ.error) {
    console.error("[api/academy/check] question lookup:", qQ.error.message);
    return NextResponse.json({ error: "server_error", scope: "question" }, { status: 500 });
  }
  if (!qQ.data) {
    return NextResponse.json({ error: "not_found", scope: "question" }, { status: 404 });
  }
  type QRow = {
    question_id: number;
    doc_id: string;
    obligation_key: string;
    doc_version: string | number | null;
    status: string;
    correct_option_id: string | null;
    options: unknown[] | null;
  };
  const q = qQ.data as QRow;
  if (
    q.doc_id !== req.doc_id ||
    q.obligation_key !== req.obligation_key ||
    q.doc_version !== req.doc_version
  ) {
    return NextResponse.json(
      {
        error: "bad_request",
        detail: "question does not belong to this requirement's module",
      },
      { status: 400 }
    );
  }
  if (q.status !== "approved") {
    return NextResponse.json(
      { error: "bad_request", detail: "question is not approved" },
      { status: 400 }
    );
  }

  const isCorrect = q.correct_option_id === selectedOptionId;
  const opts: OptionShape[] = Array.isArray(q.options)
    ? (q.options as OptionShape[])
    : [];
  const selectedOpt = opts.find((o) => o && o.id === selectedOptionId);
  if (!selectedOpt) {
    return NextResponse.json(
      {
        error: "bad_request",
        detail: "selectedOptionId does not match any option on this question",
      },
      { status: 400 }
    );
  }
  const explanation = String(selectedOpt.explanation || "");

  // Record the attempt. Every attempt, right or wrong. Insert-only.
  const insQ = await supa
    .from("academy_check_attempts")
    .insert({
      worker_id: identity.workerId,
      person_id: identity.personId,
      requirement_id: requirementId,
      question_id: Number(questionId),
      doc_version: req.doc_version,
      selected_option_id: selectedOptionId,
      correct: isCorrect,
    })
    .select("attempt_id, attempted_at")
    .single();
  if (insQ.error) {
    console.error("[api/academy/check] attempt insert:", insQ.error.message);
    return NextResponse.json({ error: "server_error", scope: "insert" }, { status: 500 });
  }

  // Bump last_seen_at on module_progress; non-fatal.
  await supa
    .from("academy_module_progress")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("worker_id", identity.workerId)
    .eq("requirement_id", requirementId);

  const insData = insQ.data as { attempt_id: string | number; attempted_at: string };
  return NextResponse.json({
    ok: true,
    correct: isCorrect,
    explanation,
    attempt_id: insData.attempt_id,
    attempted_at: insData.attempted_at,
  });
}
