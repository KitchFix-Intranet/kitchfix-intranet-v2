// POST /api/academy/admin/questions/[questionId]/save-as-draft
//
// The one path to editing an approved question. Writes the edited
// fields and sets status='draft', clearing approved_by + approved_at
// in the same write, so an approved question stops being served to
// learners at the same instant its new text / answers land. Someone
// re-approves when ready.
//
// Past attempts in academy_check_attempts are untouched (append-only
// table; service_role has no DELETE). Each row keeps the verdict it
// was graded with.
//
// Also valid against a draft (idempotent - still sets status='draft'
// and clears approved_by/at, which are already null). Retired is
// terminal, so this refuses it.

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
    console.error("[admin/questions/save-as-draft] lookup:", curQ.error.message);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
  if (!curQ.data) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const status = (curQ.data as { status: string }).status;
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
      status: "draft",
      approved_by: null,
      approved_at: null,
    })
    .eq("question_id", qid)
    .select("question_id, status")
    .single();
  if (upd.error) {
    console.error("[admin/questions/save-as-draft] update:", upd.error.message);
    return NextResponse.json(
      { error: "server_error", detail: upd.error.message },
      { status: 500 },
    );
  }

  void g.email;
  return NextResponse.json({ ok: true, question: upd.data });
}
