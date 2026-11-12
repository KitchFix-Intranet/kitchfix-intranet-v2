// POST /api/academy/admin/questions/[questionId]/retire
//
// Retire a question. Valid from ANY status (draft or approved) at
// ANY attempt count - retiring an approved question with learner
// history is exactly the safe path delete cannot take (service_role
// has no DELETE grant on academy_questions, and attempts are
// append-only anyway). Retired is terminal.
//
// Writes: status='retired'. approved_by + approved_at are kept so the
// audit of who approved it + when stays on the row. Past attempts in
// academy_check_attempts are untouched.
//
// Already retired -> 409 (idempotency-friendly caller UI, but the
// route still returns a distinct code so a double-click does not
// silently look like a fresh retire).

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
    .select("question_id, status")
    .eq("question_id", qid)
    .maybeSingle();
  if (curQ.error) {
    console.error("[admin/questions/retire] lookup:", curQ.error.message);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
  if (!curQ.data) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const status = (curQ.data as { status: string }).status;
  if (status === "retired") {
    return NextResponse.json({ error: "already_retired" }, { status: 409 });
  }

  const upd = await supa
    .from("academy_questions")
    .update({ status: "retired" })
    .eq("question_id", qid)
    .select("question_id, status")
    .single();
  if (upd.error) {
    console.error("[admin/questions/retire] update:", upd.error.message);
    return NextResponse.json(
      { error: "server_error", detail: upd.error.message },
      { status: 500 },
    );
  }

  void g.email;
  return NextResponse.json({ ok: true, question: upd.data });
}
