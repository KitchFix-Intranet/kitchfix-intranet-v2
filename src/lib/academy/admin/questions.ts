// src/lib/academy/admin/questions.ts
//
// Authoring-only loader for /academy/admin/questions. Every caller is
// already behind requireQuestionsAuthor / requireQuestionsAuthorApi, so
// this view reads correct_option_id + options + approved_by columns the
// learner-path (src/lib/academy/module.ts) is forbidden from touching.
// Do not call from any learner path. The grader in /api/academy/check
// owns the only other read of correct_option_id.
//
// Coverage view: one row per academy_obligations entry (the catalog of
// modules), with its document title and active (draft + approved, not
// retired) question count. "Live" = catalog, not cycle-scoped - authored
// questions carry to any future cycle that reuses the same (doc_id,
// obligation_key, doc_version).
//
// Status pill shape (R-AC14, 2-4 per module):
//   0        -> "none"        (needs starting)
//   1        -> "needs more"  (below floor)
//   2..4     -> "good"
//   5+       -> "trim"        (over cap)
// Retired questions do not count toward active coverage.

import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "@/lib/supabase/service";

export type QuestionStatus = "draft" | "approved" | "retired";

export interface AuthorOption {
  id: string;
  text: string;
  explanation?: string;
}

export interface AuthorQuestion {
  question_id: number;
  question_key: string;
  doc_id: string;
  obligation_key: string;
  doc_version: string;
  section_anchor: string | null;
  prompt: string;
  options: AuthorOption[];
  correct_option_id: string;
  status: QuestionStatus;
  approved_by: string | null;
  approved_at: string | null;
  sort_order: number;
  created_at: string;
}

export interface ObligationCoverage {
  doc_id: string;
  doc_title: string;
  obligation_key: string;
  doc_version: string;
  description: string | null;
  est_minutes: number | null;
  type: string | null;
  cadence: string | null;
  approvedCount: number;
  draftCount: number;
  retiredCount: number;
  activeCount: number;
}

export interface AdminQuestionsData {
  coverage: ObligationCoverage[];
  questionsByModule: Record<string, AuthorQuestion[]>;
  totals: {
    approvedTotal: number;
    draftTotal: number;
    retiredTotal: number;
    modulesWithZero: number;
    modulesInCatalog: number;
  };
}

export function moduleKey(
  doc_id: string,
  obligation_key: string,
  doc_version: string,
): string {
  return `${doc_id}|${obligation_key}|${doc_version}`;
}

export async function loadAdminQuestions(
  supaIn?: SupabaseClient,
): Promise<AdminQuestionsData> {
  const supa = supaIn || serviceClient();

  const [obQ, qQ] = await Promise.all([
    supa
      .from("academy_obligations")
      .select(
        "doc_id, obligation_key, doc_version, est_minutes, type, cadence, description",
      )
      .order("doc_id", { ascending: true })
      .order("obligation_key", { ascending: true }),
    // AUTHORING LOADER - correct_option_id + options + approved_by are
    // included here on purpose. The learner path in src/lib/academy/
    // module.ts must NOT add these columns to its select.
    supa
      .from("academy_questions")
      .select(
        "question_id, question_key, doc_id, obligation_key, doc_version, section_anchor, prompt, options, correct_option_id, status, approved_by, approved_at, sort_order, created_at",
      )
      .order("doc_id", { ascending: true })
      .order("obligation_key", { ascending: true })
      .order("sort_order", { ascending: true })
      .order("question_id", { ascending: true }),
  ]);
  if (obQ.error) throw new Error(`loadAdminQuestions obligations: ${obQ.error.message}`);
  if (qQ.error) throw new Error(`loadAdminQuestions questions: ${qQ.error.message}`);

  type ObRow = {
    doc_id: string;
    obligation_key: string;
    doc_version: string;
    est_minutes: number | null;
    type: string | null;
    cadence: string | null;
    description: string | null;
  };
  const obRows = (obQ.data as ObRow[]) || [];

  type QRow = Omit<AuthorQuestion, "options"> & { options: unknown };
  const qRows = (qQ.data as QRow[]) || [];

  const docIds = Array.from(new Set(obRows.map((o) => o.doc_id)));
  const titleByDocId = new Map<string, string>();
  if (docIds.length > 0) {
    const docQ = await supa
      .from("documents")
      .select("id, title")
      .in("id", docIds);
    if (docQ.error) {
      throw new Error(`loadAdminQuestions documents: ${docQ.error.message}`);
    }
    for (const r of (docQ.data as Array<{ id: string; title: string | null }>) || []) {
      if (r.title) titleByDocId.set(r.id, r.title);
    }
  }

  const questionsByModule: Record<string, AuthorQuestion[]> = {};
  for (const r of qRows) {
    const key = moduleKey(r.doc_id, r.obligation_key, r.doc_version);
    const opts: AuthorOption[] = Array.isArray(r.options)
      ? (r.options as unknown[]).map((o) => {
          const x = (o || {}) as { id?: unknown; text?: unknown; explanation?: unknown };
          return {
            id: typeof x.id === "string" ? x.id : "",
            text: typeof x.text === "string" ? x.text : "",
            explanation:
              typeof x.explanation === "string" ? x.explanation : undefined,
          };
        })
      : [];
    const q: AuthorQuestion = {
      question_id: Number(r.question_id),
      question_key: r.question_key,
      doc_id: r.doc_id,
      obligation_key: r.obligation_key,
      doc_version: r.doc_version,
      section_anchor: r.section_anchor,
      prompt: r.prompt,
      options: opts,
      correct_option_id: r.correct_option_id,
      status: r.status as QuestionStatus,
      approved_by: r.approved_by,
      approved_at: r.approved_at,
      sort_order: Number(r.sort_order) || 0,
      created_at: r.created_at,
    };
    (questionsByModule[key] = questionsByModule[key] || []).push(q);
  }

  const coverage: ObligationCoverage[] = obRows.map((o) => {
    const mk = moduleKey(o.doc_id, o.obligation_key, o.doc_version);
    const list = questionsByModule[mk] || [];
    let approvedCount = 0;
    let draftCount = 0;
    let retiredCount = 0;
    for (const q of list) {
      if (q.status === "approved") approvedCount++;
      else if (q.status === "draft") draftCount++;
      else if (q.status === "retired") retiredCount++;
    }
    return {
      doc_id: o.doc_id,
      doc_title: titleByDocId.get(o.doc_id) || o.doc_id,
      obligation_key: o.obligation_key,
      doc_version: o.doc_version,
      description: o.description,
      est_minutes: o.est_minutes,
      type: o.type,
      cadence: o.cadence,
      approvedCount,
      draftCount,
      retiredCount,
      activeCount: approvedCount + draftCount,
    };
  });

  let approvedTotal = 0;
  let draftTotal = 0;
  let retiredTotal = 0;
  let modulesWithZero = 0;
  for (const c of coverage) {
    approvedTotal += c.approvedCount;
    draftTotal += c.draftCount;
    retiredTotal += c.retiredCount;
    if (c.activeCount === 0) modulesWithZero++;
  }

  return {
    coverage,
    questionsByModule,
    totals: {
      approvedTotal,
      draftTotal,
      retiredTotal,
      modulesWithZero,
      modulesInCatalog: coverage.length,
    },
  };
}
