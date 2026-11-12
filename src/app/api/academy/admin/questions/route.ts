// POST /api/academy/admin/questions
//
// Create a new question in draft status. Author-gated: owners pass
// automatically, non-owners pass with grant_type='academy_questions_author'
// in academy_grants (requireQuestionsAuthorApi).
//
// Body: {
//   doc_id, obligation_key, doc_version,   // module binding (required)
//   prompt, options, correct_option_id,    // content (required)
//   question_key,                          // stable unique slug (required - no default)
//   section_anchor?, sort_order?,
// }
//
// Enforcement:
//   - the module (doc_id, obligation_key, doc_version) must exist in
//     academy_obligations;
//   - question_key is unique per (doc_id, obligation_key, doc_version)
//     by table unique index - caught + reported clearly here;
//   - options shape (2..4, each id unique + text non-empty) + correct_option_id
//     matching one option id - validateQuestionFields.
//
// Writes:
//   INSERT academy_questions with status='draft', no approved_by/at.
//   No DELETE is ever issued against academy_questions (service_role
//   has no DELETE grant on that table - retire is the terminal state).

import { NextRequest, NextResponse } from "next/server";
import { requireQuestionsAuthorApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { validateQuestionFields } from "@/lib/academy/admin/questionValidate";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const g = await requireQuestionsAuthorApi();
  if (g instanceof Response) return g;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "bad_request", detail: "invalid JSON body" },
      { status: 400 },
    );
  }

  const doc_id = typeof body.doc_id === "string" ? body.doc_id.trim() : "";
  const obligation_key =
    typeof body.obligation_key === "string" ? body.obligation_key.trim() : "";
  const doc_version =
    typeof body.doc_version === "string"
      ? body.doc_version.trim()
      : body.doc_version != null
        ? String(body.doc_version).trim()
        : "";
  if (!doc_id || !obligation_key || !doc_version) {
    return NextResponse.json(
      {
        error: "bad_request",
        detail: "doc_id, obligation_key, doc_version are required",
      },
      { status: 400 },
    );
  }

  const v = validateQuestionFields(body, { requireQuestionKey: true });
  if (!v.ok || !v.clean) {
    return NextResponse.json(
      { error: "bad_request", details: v.errors },
      { status: 400 },
    );
  }
  const clean = v.clean;

  const supa = serviceClient();

  // Confirm the module exists in the obligations catalog.
  const obQ = await supa
    .from("academy_obligations")
    .select("doc_id")
    .eq("doc_id", doc_id)
    .eq("obligation_key", obligation_key)
    .eq("doc_version", doc_version)
    .maybeSingle();
  if (obQ.error) {
    console.error("[admin/questions/create] obligations lookup:", obQ.error.message);
    return NextResponse.json({ error: "server_error", scope: "obligations" }, { status: 500 });
  }
  if (!obQ.data) {
    return NextResponse.json(
      {
        error: "bad_request",
        detail: `No obligation matches ${doc_id} / ${obligation_key} / ${doc_version}`,
      },
      { status: 400 },
    );
  }

  const ins = await supa
    .from("academy_questions")
    .insert({
      doc_id,
      obligation_key,
      doc_version,
      question_key: clean.question_key,
      section_anchor: clean.section_anchor,
      prompt: clean.prompt,
      options: clean.options,
      correct_option_id: clean.correct_option_id,
      status: "draft",
      sort_order: clean.sort_order,
    })
    .select("question_id, status, question_key")
    .single();
  if (ins.error) {
    const msg = ins.error.message || "";
    if (/unique/i.test(msg) || ins.error.code === "23505") {
      return NextResponse.json(
        {
          error: "bad_request",
          detail: `question_key "${clean.question_key}" already exists on ${doc_id} / ${obligation_key} / ${doc_version}. Pick a different slug.`,
        },
        { status: 409 },
      );
    }
    console.error("[admin/questions/create] insert:", msg);
    return NextResponse.json(
      { error: "server_error", detail: msg },
      { status: 500 },
    );
  }

  void g.email;
  return NextResponse.json({ ok: true, question: ins.data });
}
