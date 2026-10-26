// src/lib/academy/module.ts
//
// Loader for /api/academy/module/[requirementId]. Returns everything
// the Focus view needs to render the read-check-sign flow for one
// requirement.
//
// SECURITY - correct_option_id NEVER leaves this module.
// ─────────────────────────────────────────────────────
// The questions query uses an EXPLICIT column list that OMITS
// correct_option_id by CONSTRUCTION. This is not a filter applied
// after the query returns; the column does not enter the query.
//
// SHUFFLE - server-side, per request (spec 18.6).
// ───────────────────────────────────────────────
// options[] is a JSONB array on each question row. Shuffled in JS
// after fetch, before returning. Shuffle happens per REQUEST so answer
// positions are not stable across attempts. The id inside each option
// is preserved; grading uses the id, not the position.
//
// PROGRESS - upserts on fetch.
// ────────────────────────────
// academy_module_progress is mutable scratch state (spec 13). On every
// fetch we upsert (worker_id, requirement_id): first fetch inserts
// started_at + last_seen_at; subsequent fetches bump last_seen_at. The
// time_spent_seconds accumulator moves on check attempts and on sign.

import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "@/lib/supabase/service";
import { resolveAcademyIdentity } from "./identity";
import type { AcademyIdentity } from "./identity";

export type ModuleResult =
  | {
      ok: false;
      status: 400 | 404 | 409 | 500;
      error: string;
      scope?: string;
      detail?: string;
      unlocks_after_part?: number;
    }
  | ({ ok: true } & ModuleBody);

export interface ModuleBody {
  viewer: {
    workerId: string;
    personId: string | null;
    displayName: string | null;
  };
  doc: {
    id: string;
    title: string;
    doc_class: string | null;
    status: string | null;
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
  content_html: string | null;
  content_rendered_at: string | null;
  requirement: {
    requirement_id: string | number;
    doc_id: string;
    obligation_key: string;
    doc_version: string | number | null;
    est_minutes: number | null;
    source: string | null;
    cycle_id: string | number | null;
    due_date: string | null;
    issued_at: string | null;
    waived: boolean;
  };
  obligation: {
    obligation_key: string;
    doc_version: string | number | null;
    source_section: string | null;
    description: string | null;
    type: string | null;
    cadence: string | null;
    est_minutes: number | null;
    applies_to: unknown;
    owner: string | null;
  } | null;
  cycle: {
    cycle_id: string | number;
    label: string;
    period_start: string | null;
    period_end: string | null;
    status: string | null;
  } | null;
  questions: WireQuestion[];
  steps: Step[];
  steps_orphan_questions: Array<string | number>;
  progress: {
    attempts_by_question: Record<string, { total: number; correct: number; last_correct_at: string | null }>;
    all_correct_ids: Array<string | number>;
    ready_to_sign: boolean;
    started_at: string;
    last_seen_at: string | null;
    time_spent_seconds: number;
    sections_seen: string[];
    furthest_step_index: number;
  };
  attestation: {
    attestation_id: string | number;
    doc_id: string;
    obligation_key: string;
    doc_version: string | number | null;
    typed_name: string | null;
    signed_at: string | null;
    attempts_count: number | null;
    time_spent_seconds: number | null;
    certificate_serial: string | null;
    source: string | null;
  } | null;
}

export interface WireQuestion {
  question_id: string | number;
  question_key: string | null;
  section_anchor: string | null;
  prompt: string;
  options: unknown[];
  sort_order: number | null;
}

export interface Step {
  key: string;
  anchor: string;
  anchors: string[];
  level: number;
  html: string;
  wordCount: number;
  questionIds: Array<string | number>;
  estMinutes: number;
}

export const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const WORDS_PER_STEP = 600;
const HEADING_RE = /<h([1-3])[^>]*>([^<]+)<\/h\1>/gi;

function decodeEntities(s: string): string {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function slugAnchor(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/&amp;/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function countWords(html: string): number {
  const text = String(html || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return 0;
  return text.split(" ").filter(Boolean).length;
}

interface HeadingNode {
  level: number;
  text: string;
  start: number;
  end: number;
  chunkHtml: string;
  wordCount: number;
  children: HeadingNode[];
}

function parseHeadingTree(html: string): HeadingNode[] {
  if (!html) return [];
  const flat: Array<Omit<HeadingNode, "end" | "chunkHtml" | "wordCount" | "children">> = [];
  const re = new RegExp(HEADING_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    flat.push({ level: Number(m[1]), text: decodeEntities(m[2]).trim(), start: m.index });
  }
  if (flat.length === 0) return [];
  const nodes: HeadingNode[] = flat.map((f) => ({
    ...f,
    end: html.length,
    chunkHtml: "",
    wordCount: 0,
    children: [],
  }));
  for (let i = 0; i < nodes.length; i += 1) {
    const cur = nodes[i];
    let end = html.length;
    for (let j = i + 1; j < nodes.length; j += 1) {
      if (nodes[j].level <= cur.level) {
        end = nodes[j].start;
        break;
      }
    }
    cur.end = end;
    cur.chunkHtml = html.slice(cur.start, cur.end);
    cur.wordCount = countWords(cur.chunkHtml);
  }
  const roots: HeadingNode[] = [];
  const stack: HeadingNode[] = [];
  for (const node of nodes) {
    while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop();
    if (stack.length === 0) roots.push(node);
    else stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return roots;
}

interface RawStep {
  key: string;
  anchor: string;
  level: number;
  html: string;
  wordCount: number;
  descended: boolean;
  parentKey: string;
}

function computeSteps(tree: HeadingNode[], sourceSectionList: string[] | null): RawStep[] {
  const inScope = (node: HeadingNode): boolean => {
    if (!sourceSectionList || sourceSectionList.length === 0) return true;
    return sourceSectionList.some(
      (s) => s.trim().toLowerCase() === node.text.trim().toLowerCase()
    );
  };
  const out: RawStep[] = [];
  const emit = (node: HeadingNode, descended: boolean, parentKey: string): void => {
    const isBig = node.wordCount > WORDS_PER_STEP && node.children.length > 0;
    if (isBig) {
      const nextParent = slugAnchor(node.text);
      for (const child of node.children) emit(child, true, nextParent);
      return;
    }
    out.push({
      key: slugAnchor(node.text),
      anchor: node.text,
      level: node.level,
      html: node.chunkHtml,
      wordCount: node.wordCount,
      descended,
      parentKey,
    });
  };
  for (const root of tree) {
    if (!inScope(root)) continue;
    emit(root, false, "");
  }
  return out;
}

const TRAILING_STUB_WORDS = 150;

function mergeSteps(
  rawSteps: RawStep[],
  stepQuestions: Array<Array<string | number>>
): { steps: Array<RawStep & { anchors: string[] }>; questionIdsByStep: Array<Array<string | number>> } {
  if (rawSteps.length === 0) return { steps: [], questionIdsByStep: [] };

  const canMerge = (aIdx: number, bIdx: number): boolean => {
    const a = rawSteps[aIdx];
    const b = rawSteps[bIdx];
    if (!a.descended || !b.descended) return false;
    if (a.parentKey !== b.parentKey) return false;
    if ((stepQuestions[aIdx]?.length || 0) > 0) return false;
    if ((stepQuestions[bIdx]?.length || 0) > 0) return false;
    return true;
  };

  const groups: number[][] = [];
  let cur: number[] = [0];
  for (let i = 1; i < rawSteps.length; i += 1) {
    const last = cur[cur.length - 1];
    const curWords = cur.reduce((acc, idx) => acc + rawSteps[idx].wordCount, 0);
    if (canMerge(last, i) && curWords + rawSteps[i].wordCount <= WORDS_PER_STEP) {
      cur.push(i);
    } else {
      groups.push(cur);
      cur = [i];
    }
  }
  groups.push(cur);

  const merged: number[][] = [];
  for (const g of groups) {
    const words = g.reduce((acc, idx) => acc + rawSteps[idx].wordCount, 0);
    if (
      words < TRAILING_STUB_WORDS &&
      merged.length > 0 &&
      canMerge(merged[merged.length - 1][merged[merged.length - 1].length - 1], g[0])
    ) {
      merged[merged.length - 1].push(...g);
    } else {
      merged.push(g);
    }
  }

  const stripLeadingHeading = (html: string): string =>
    String(html || "").replace(/^\s*<h[1-3][^>]*>[^<]*<\/h[1-3]>\s*/i, "");

  const steps: Array<RawStep & { anchors: string[] }> = [];
  const questionIdsByStep: Array<Array<string | number>> = [];
  for (const g of merged) {
    const first = rawSteps[g[0]];
    const anchors = g.map((idx) => rawSteps[idx].anchor);
    const wordCount = g.reduce((acc, idx) => acc + rawSteps[idx].wordCount, 0);
    const chunks = g.map((idx, j) =>
      j === 0 ? stripLeadingHeading(rawSteps[idx].html) : rawSteps[idx].html
    );
    const html = chunks.join("");
    const questionIds = g.flatMap((idx) => stepQuestions[idx] || []);
    steps.push({
      ...first,
      anchors,
      html,
      wordCount,
    });
    questionIdsByStep.push(questionIds);
  }
  return { steps, questionIdsByStep };
}

export async function loadModule(
  email: string,
  requirementId: string,
  supaIn?: SupabaseClient
): Promise<ModuleResult> {
  if (!requirementId || !UUID_RE.test(requirementId)) {
    return {
      ok: false,
      status: 400,
      error: "bad_request",
      detail: "requirementId must be a UUID",
    };
  }

  const supa = supaIn || serviceClient();

  let identity: AcademyIdentity | null;
  try {
    identity = await resolveAcademyIdentity(email, { supa });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[academy/loadModule] resolve threw:", msg);
    return { ok: false, status: 500, error: "server_error", scope: "identity" };
  }
  if (!identity) {
    return { ok: false, status: 404, error: "no_roster_row" };
  }

  const reqQ = await supa
    .from("academy_requirements")
    .select(
      "requirement_id, worker_id, person_id, doc_id, obligation_key, doc_version, est_minutes, source, cycle_id, due_date, issued_at, waived_at, waive_reason"
    )
    .eq("requirement_id", requirementId)
    .eq("worker_id", identity.workerId)
    .maybeSingle();
  if (reqQ.error) {
    console.error("[academy/loadModule] requirement:", reqQ.error.message);
    return { ok: false, status: 500, error: "server_error", scope: "requirement" };
  }
  if (!reqQ.data) {
    return { ok: false, status: 404, error: "not_found" };
  }
  type RequirementRow = {
    requirement_id: string | number;
    worker_id: string;
    person_id: string | null;
    doc_id: string;
    obligation_key: string;
    doc_version: string | number | null;
    est_minutes: number | null;
    source: string | null;
    cycle_id: string | number | null;
    due_date: string | null;
    issued_at: string | null;
    waived_at: string | null;
    waive_reason: string | null;
  };
  const req = reqQ.data as RequirementRow;

  // Part-lock gate (spec 18.4). Siblings = same worker, same doc_id,
  // same cycle. Sort by obligation_key. If any earlier sibling is
  // unsigned + not waived, this part is locked.
  {
    const siblingsQ = await supa
      .from("academy_requirements")
      .select("requirement_id, obligation_key, waived_at")
      .eq("worker_id", identity.workerId)
      .eq("doc_id", req.doc_id)
      .eq("cycle_id", req.cycle_id);
    if (siblingsQ.error) {
      console.error("[academy/loadModule] part-lock siblings:", siblingsQ.error.message);
      return { ok: false, status: 500, error: "server_error", scope: "part_lock" };
    }
    const siblings = (
      (siblingsQ.data as Array<{
        requirement_id: string | number;
        obligation_key: string;
        waived_at: string | null;
      }>) || []
    )
      .filter((s) => s.waived_at == null)
      .sort((a, b) => a.obligation_key.localeCompare(b.obligation_key));
    if (siblings.length > 1) {
      const partIdx = siblings.findIndex((s) => s.requirement_id === req.requirement_id);
      if (partIdx > 0) {
        const priorIds = siblings.slice(0, partIdx).map((s) => s.requirement_id);
        const priorAttQ = await supa
          .from("academy_attestations")
          .select("requirement_id")
          .in("requirement_id", priorIds);
        if (priorAttQ.error) {
          console.error("[academy/loadModule] part-lock attestations:", priorAttQ.error.message);
          return { ok: false, status: 500, error: "server_error", scope: "part_lock" };
        }
        const signedPrior = new Set(
          ((priorAttQ.data as Array<{ requirement_id: string | number }>) || []).map(
            (a) => a.requirement_id
          )
        );
        const unsignedPrior = priorIds.filter((id) => !signedPrior.has(id));
        if (unsignedPrior.length > 0) {
          return {
            ok: false,
            status: 409,
            error: "part_locked",
            detail: `Part ${partIdx + 1} is locked until Part ${partIdx} is signed.`,
            unlocks_after_part: partIdx,
          };
        }
      }
    }
  }

  const [docQ, obQ, cycleQ, contentQ, questionsQ, attemptsQ, attestationQ, progressQ] =
    await Promise.all([
      supa
        .from("documents")
        .select(
          "id, title, doc_class, status, version, shelf, owner, approver, effective_date, last_reviewed, next_review, updated_at, card_line, summary"
        )
        .eq("id", req.doc_id)
        .maybeSingle(),
      supa
        .from("academy_obligations")
        .select(
          "doc_id, obligation_key, doc_version, source_section, description, type, cadence, est_minutes, applies_to, owner"
        )
        .eq("doc_id", req.doc_id)
        .eq("obligation_key", req.obligation_key)
        .maybeSingle(),
      req.cycle_id != null
        ? supa
            .from("academy_cycles")
            .select(
              "cycle_id, label, period_start, period_end, status, fiscal_year, fiscal_period_no"
            )
            .eq("cycle_id", req.cycle_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      supa
        .from("document_content")
        .select("html, content_hash, rendered_at")
        .eq("doc_id", req.doc_id)
        .eq("lang", "en")
        .maybeSingle(),
      // CRITICAL - explicit column list, correct_option_id OMITTED by
      // construction. Do NOT swap to select("*"); the grader in /check
      // owns the only path that reads correct_option_id.
      supa
        .from("academy_questions")
        .select(
          "question_id, question_key, doc_id, obligation_key, doc_version, section_anchor, prompt, options, sort_order"
        )
        .eq("doc_id", req.doc_id)
        .eq("obligation_key", req.obligation_key)
        .eq("doc_version", req.doc_version)
        .eq("status", "approved")
        .order("sort_order", { ascending: true }),
      supa
        .from("academy_check_attempts")
        .select("attempt_id, question_id, selected_option_id, correct, attempted_at")
        .eq("worker_id", identity.workerId)
        .eq("requirement_id", requirementId)
        .order("attempted_at", { ascending: true }),
      supa
        .from("academy_attestations")
        .select(
          "attestation_id, worker_id, doc_id, obligation_key, doc_version, typed_name, signed_at, attempts_count, time_spent_seconds, certificate_serial, source"
        )
        .eq("worker_id", identity.workerId)
        .eq("requirement_id", requirementId)
        .maybeSingle(),
      supa
        .from("academy_module_progress")
        .select(
          "worker_id, requirement_id, sections_seen, started_at, last_seen_at, time_spent_seconds"
        )
        .eq("worker_id", identity.workerId)
        .eq("requirement_id", requirementId)
        .maybeSingle(),
    ]);

  const subErrorChecks: Array<[string, { error: { message: string } | null }]> = [
    ["doc", docQ],
    ["obligation", obQ],
    ["cycle", cycleQ],
    ["content", contentQ],
    ["questions", questionsQ],
    ["attempts", attemptsQ],
    ["attestation", attestationQ],
    ["progress", progressQ],
  ];
  for (const [scope, q] of subErrorChecks) {
    if (q.error) {
      console.error(`[academy/loadModule] ${scope}:`, q.error.message);
      return { ok: false, status: 500, error: "server_error", scope };
    }
  }
  if (!docQ.data) {
    return { ok: false, status: 404, error: "not_found", scope: "doc" };
  }

  type DocRow = {
    id: string;
    title: string | null;
    doc_class: string | null;
    status: string | null;
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
  type ObRow = {
    doc_id: string;
    obligation_key: string;
    doc_version: string | number | null;
    source_section: string | null;
    description: string | null;
    type: string | null;
    cadence: string | null;
    est_minutes: number | null;
    applies_to: unknown;
    owner: string | null;
  };
  type CycRow = {
    cycle_id: string | number;
    label: string;
    period_start: string | null;
    period_end: string | null;
    status: string | null;
  };
  type ContentRow = { html: string | null; content_hash: string | null; rendered_at: string | null };
  type QuestionRow = {
    question_id: string | number;
    question_key: string | null;
    doc_id: string;
    obligation_key: string;
    doc_version: string | number | null;
    section_anchor: string | null;
    prompt: string;
    options: unknown[] | null;
    sort_order: number | null;
  };
  type AttemptRow = {
    attempt_id: string | number;
    question_id: string | number;
    selected_option_id: string | number | null;
    correct: boolean | null;
    attempted_at: string | null;
  };
  type AttestationRow = {
    attestation_id: string | number;
    worker_id: string;
    doc_id: string;
    obligation_key: string;
    doc_version: string | number | null;
    typed_name: string | null;
    signed_at: string | null;
    attempts_count: number | null;
    time_spent_seconds: number | null;
    certificate_serial: string | null;
    source: string | null;
  };
  type ProgressRow = {
    worker_id: string;
    requirement_id: string | number;
    sections_seen: unknown;
    started_at: string | null;
    last_seen_at: string | null;
    time_spent_seconds: number | null;
  };

  const doc = docQ.data as DocRow;
  const ob = (obQ.data as ObRow | null) || null;
  const cyc = (cycleQ.data as CycRow | null) || null;
  const content = (contentQ.data as ContentRow | null) || null;
  const questions = (questionsQ.data as QuestionRow[]) || [];
  const attempts = (attemptsQ.data as AttemptRow[]) || [];
  const attestation = (attestationQ.data as AttestationRow | null) || null;
  const progressRow = (progressQ.data as ProgressRow | null) || null;

  // Progress upsert.
  if (progressRow == null) {
    const insQ = await supa
      .from("academy_module_progress")
      .insert({
        worker_id: identity.workerId,
        requirement_id: requirementId,
        sections_seen: [],
        started_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        time_spent_seconds: 0,
      });
    if (insQ.error) {
      console.error("[academy/loadModule] progress insert:", insQ.error.message);
    }
  } else {
    const updQ = await supa
      .from("academy_module_progress")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("worker_id", identity.workerId)
      .eq("requirement_id", requirementId);
    if (updQ.error) {
      console.error("[academy/loadModule] progress update:", updQ.error.message);
    }
  }

  const attemptsByQuestion: Record<
    string,
    { total: number; correct: number; last_correct_at: string | null }
  > = {};
  const correctByQuestion = new Set<string | number>();
  for (const a of attempts) {
    const key = String(a.question_id);
    const bucket =
      attemptsByQuestion[key] || { total: 0, correct: 0, last_correct_at: null };
    bucket.total += 1;
    if (a.correct) {
      bucket.correct += 1;
      bucket.last_correct_at = a.attempted_at;
      correctByQuestion.add(a.question_id);
    }
    attemptsByQuestion[key] = bucket;
  }
  const readyToSign =
    questions.length === 0 || questions.every((q) => correctByQuestion.has(q.question_id));

  const sourceSectionList = ob?.source_section
    ? String(ob.source_section)
        .split(/;\s*/)
        .map((s) => s.trim())
        .filter(Boolean)
    : null;
  const headingTree = parseHeadingTree(content?.html || "");
  const rawSteps = computeSteps(headingTree, sourceSectionList);

  const anchorIndex = new Map<string, number>();
  rawSteps.forEach((s, i) => anchorIndex.set(s.anchor.toLowerCase(), i));
  const rawStepQuestions: Array<Array<string | number>> = rawSteps.map(() => []);
  const orphanQuestionIds: Array<string | number> = [];
  for (const q of questions) {
    const key = String(q.section_anchor || "").trim().toLowerCase();
    const idx = anchorIndex.get(key);
    if (idx == null) {
      orphanQuestionIds.push(q.question_id);
    } else {
      rawStepQuestions[idx].push(q.question_id);
    }
  }
  const { steps: mergedSteps, questionIdsByStep } = mergeSteps(rawSteps, rawStepQuestions);
  const steps: Step[] = mergedSteps.map((s, i) => ({
    key: s.key,
    anchor: s.anchor,
    anchors: s.anchors,
    level: s.level,
    html: s.html,
    wordCount: s.wordCount,
    questionIds: questionIdsByStep[i],
    estMinutes: Math.max(1, Math.ceil(s.wordCount / 200)),
  }));

  const seenKeys = new Set<string>(
    Array.isArray(progressRow?.sections_seen) ? (progressRow!.sections_seen as string[]) : []
  );
  let furthestStepIndex = 0;
  for (let i = 0; i < steps.length; i += 1) {
    if (seenKeys.has(steps[i].key)) furthestStepIndex = i + 1;
    else break;
  }

  const wireQuestions: WireQuestion[] = questions.map((q) => ({
    question_id: q.question_id,
    question_key: q.question_key,
    section_anchor: q.section_anchor,
    prompt: q.prompt,
    options: shuffle(Array.isArray(q.options) ? q.options : []),
    sort_order: q.sort_order,
  }));

  return {
    ok: true,
    viewer: {
      workerId: identity.workerId,
      personId: identity.personId,
      displayName: identity.displayName,
    },
    doc: {
      id: doc.id,
      title: doc.title || doc.id,
      doc_class: doc.doc_class,
      status: doc.status,
      version: doc.version,
      shelf: doc.shelf,
      owner: doc.owner,
      approver: doc.approver,
      effective_date: doc.effective_date,
      last_reviewed: doc.last_reviewed,
      next_review: doc.next_review,
      updated_at: doc.updated_at,
      card_line: doc.card_line,
      summary: doc.summary,
    },
    content_html: content?.html || null,
    content_rendered_at: content?.rendered_at || null,
    requirement: {
      requirement_id: req.requirement_id,
      doc_id: req.doc_id,
      obligation_key: req.obligation_key,
      doc_version: req.doc_version,
      est_minutes: req.est_minutes,
      source: req.source,
      cycle_id: req.cycle_id,
      due_date: req.due_date,
      issued_at: req.issued_at,
      waived: req.waived_at != null,
    },
    obligation: ob
      ? {
          obligation_key: ob.obligation_key,
          doc_version: ob.doc_version,
          source_section: ob.source_section,
          description: ob.description,
          type: ob.type,
          cadence: ob.cadence,
          est_minutes: ob.est_minutes,
          applies_to: ob.applies_to,
          owner: ob.owner,
        }
      : null,
    cycle: cyc
      ? {
          cycle_id: cyc.cycle_id,
          label: cyc.label,
          period_start: cyc.period_start,
          period_end: cyc.period_end,
          status: cyc.status,
        }
      : null,
    questions: wireQuestions,
    steps,
    steps_orphan_questions: orphanQuestionIds,
    progress: {
      attempts_by_question: attemptsByQuestion,
      all_correct_ids: [...correctByQuestion],
      ready_to_sign: readyToSign,
      started_at: progressRow?.started_at || new Date().toISOString(),
      last_seen_at: progressRow?.last_seen_at || null,
      time_spent_seconds: progressRow?.time_spent_seconds ?? 0,
      sections_seen: Array.isArray(progressRow?.sections_seen)
        ? (progressRow!.sections_seen as string[])
        : [],
      furthest_step_index: furthestStepIndex,
    },
    attestation: attestation
      ? {
          attestation_id: attestation.attestation_id,
          doc_id: attestation.doc_id,
          obligation_key: attestation.obligation_key,
          doc_version: attestation.doc_version,
          typed_name: attestation.typed_name,
          signed_at: attestation.signed_at,
          attempts_count: attestation.attempts_count,
          time_spent_seconds: attestation.time_spent_seconds,
          certificate_serial: attestation.certificate_serial,
          source: attestation.source,
        }
      : null,
  };
}
