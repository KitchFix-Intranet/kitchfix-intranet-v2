// POST /api/academy/admin/questions/[questionId]/save
//
// Edit a DRAFT question in place. Author-gated.
//
// Disabled for approved questions: a bare "Save" cannot silently rewrite
// a live question's text, answers, or correct option out from under
// learners who may be mid-attempt. The editor hides / disables this
// button when status='approved'; this route rejects it with a 409 even
// if the client bypasses the UI check. The one path to editing an
// approved question is save-as-draft, which demotes status back to
// draft in the same write so learners stop being served it.
//
// Retired questions are terminal - this route refuses them too.
//
// Fields saved: prompt, options, correct_option_id, section_anchor,
// sort_order. question_key is NOT editable here (it is the stable
// slug). status is unchanged.

import { NextRequest, NextResponse } from "next/server";
import { requireQuestionsAuthorApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import {
  validateQuestionFields,
  parseQuestionId,
} from "@/lib/academy/admin/questionValidate";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
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

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "bad_request", detail: "invalid JSON body" },
      { status: 400 },
    );
  }

  const v = validateQuestionFields(body, { requireQuestionKey: false });
  if (!v.ok || !v.clean) {
    return NextResponse.json(
      { error: "bad_request", details: v.errors },
      { status: 400 },
    );
  }
  const clean = v.clean;

  const supa = serviceClient();
  const curQ = await supa
    .from("academy_questions")
    .select("question_id, status")
    .eq("question_id", qid)
    .maybeSingle();
  if (curQ.error) {
    console.error("[admin/questions/save] lookup:", curQ.error.message);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
  if (!curQ.data) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const status = (curQ.data as { status: string }).status;
  if (status === "approved") {
    return NextResponse.json(
      {
        error: "cannot_edit_approved",
        detail:
          "This question is approved and live. Use Save as draft to edit it - that demotes it to draft in the same write so no learner is served it mid-edit.",
      },
      { status: 409 },
    );
  }
  if (status === "retired") {
    return NextResponse.json(
      {
        error: "cannot_edit_retired",
        detail: "Retired questions are terminal and cannot be edited.",
      },
      { status: 409 },
    );
  }

  const upd = await supa
    .from("academy_questions")
    .update({
      prompt: clean.prompt,
      options: clean.options,
      correct_option_id: clean.correct_option_id,
      section_anchor: clean.section_anchor,
      sort_order: clean.sort_order,
    })
    .eq("question_id", qid)
    .select("question_id, status")
    .single();
  if (upd.error) {
    console.error("[admin/questions/save] update:", upd.error.message);
    return NextResponse.json(
      { error: "server_error", detail: upd.error.message },
      { status: 500 },
    );
  }

  void g.email;
  return NextResponse.json({ ok: true, question: upd.data });
}
