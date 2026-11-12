// POST /api/academy/admin/questions/[questionId]/approve
//
// Promote a DRAFT question to APPROVED. Author-gated. Validates the
// stored row re-reads shape (correct_option_id matches an option id,
// >=2 options, prompt non-empty) so a direct DB-tier edit cannot
// sneak an invalid question past this gate; approved + invalid would
// reach the learner's module loader (status='approved').
//
// Writes: status='approved', approved_by = session email, approved_at
// = now(). Approved questions reach learners immediately on the next
// module load (learner path is .eq('status','approved')).
//
// Already approved -> 409 (handled by the editor by hiding the button,
// but the route rejects it for API consumers too).

import { NextRequest, NextResponse } from "next/server";
import { requireQuestionsAuthorApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { parseQuestionId } from "@/lib/academy/admin/questionValidate";

export const dynamic = "force-dynamic";

export async function POST(
  _request: NextRequest,
  ctx: { params: Promise<{ questionId: string }> },
) {
  const g = await requireQuestionsAuthorApi();
  if (g instanceof Response) return g;

  const { questionId } = await ctx.params;
  const qid = parseQuestionId(questionId);
  if (qid == null) {
    return NextResponse.json(
      { error: "bad_request", detail: "questionId must be a positive integer" },
      { status: 400 },
    );
  }

  const supa = serviceClient();
  const curQ = await supa
    .from("academy_questions")
    .select("question_id, status, prompt, options, correct_option_id")
    .eq("question_id", qid)
    .maybeSingle();
  if (curQ.error) {
    console.error("[admin/questions/approve] lookup:", curQ.error.message);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
  if (!curQ.data) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const row = curQ.data as {
    status: string;
    prompt: string;
    options: unknown;
    correct_option_id: string;
  };
  if (row.status === "approved") {
    return NextResponse.json(
      { error: "already_approved" },
      { status: 409 },
    );
  }
  if (row.status === "retired") {
    return NextResponse.json(
      {
        error: "cannot_approve_retired",
        detail: "Retired questions cannot be approved.",
      },
      { status: 409 },
    );
  }

  const errors: string[] = [];
  if (!row.prompt || !row.prompt.trim()) errors.push("prompt is empty.");
  const opts = Array.isArray(row.options) ? row.options : [];
  if (opts.length < 2) errors.push("A question needs at least two options.");
  if (opts.length > 4) errors.push("A question has no more than four options.");
  const ids = new Set<string>();
  for (const o of opts) {
    const x = (o || {}) as { id?: unknown; text?: unknown };
    const id = typeof x.id === "string" ? x.id : "";
    const text = typeof x.text === "string" ? x.text.trim() : "";
    if (id) ids.add(id);
    if (!text) errors.push(`an option has empty text.`);
  }
  if (!row.correct_option_id || !ids.has(row.correct_option_id)) {
    errors.push("correct_option_id must match one of the options.");
  }
  if (errors.length > 0) {
    return NextResponse.json(
      { error: "bad_request", details: errors },
      { status: 400 },
    );
  }

  const upd = await supa
    .from("academy_questions")
    .update({
      status: "approved",
      approved_by: g.email,
      approved_at: new Date().toISOString(),
    })
    .eq("question_id", qid)
    .select("question_id, status, approved_by, approved_at")
    .single();
  if (upd.error) {
    console.error("[admin/questions/approve] update:", upd.error.message);
    return NextResponse.json(
      { error: "server_error", detail: upd.error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, question: upd.data });
}
