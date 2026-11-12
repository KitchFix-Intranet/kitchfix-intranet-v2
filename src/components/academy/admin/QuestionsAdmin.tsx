"use client";

// Admin / Questions. One client island hands over the whole page's
// interactivity so the RSC boundary stays clean (server page passes
// data props only; no handler / hook crosses). The island does:
//
//   - the coverage view (left): one row per obligations-catalog module
//     with doc title, obligation key, version, active count + pill
//   - the editor (right): the currently selected question's fields,
//     with Save / Save as draft / Approve buttons and a header Retire
//   - the New question flow: inline editor scoped to the selected
//     module, posting to /api/academy/admin/questions
//
// Lifecycle rules (matching the V7 render's button set, not an
// un-approve step):
//   - Save: disabled when status='approved' (bare Save cannot rewrite
//     a live question out from under mid-attempt learners)
//   - Save as draft: writes edits + sets status='draft' in the same
//     write, always enabled. This is the one path to editing an
//     approved question. Past attempts are untouched (append-only).
//   - Approve: hidden when already approved; validates fields, sets
//     status='approved' + approved_by/at
//   - Retire: terminal; allowed at any status; replaces delete
//     (service_role has no DELETE grant on academy_questions)

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Plus,
  Check,
  CheckCircle2,
  Save as SaveIcon,
  Archive,
  Loader2,
  AlertCircle,
} from "lucide-react";
import type {
  AdminQuestionsData,
  AuthorQuestion,
  ObligationCoverage,
} from "@/lib/academy/admin/questions";
import { moduleKey } from "@/lib/academy/admin/questions";
import { AcademyBand, type AcademyBandFact } from "@/components/academy/AcademyBand";

type Props = { data: AdminQuestionsData };

type Selection =
  | { kind: "none" }
  | { kind: "existing"; questionId: number }
  | { kind: "new"; modKey: string };

interface EditorFields {
  prompt: string;
  options: Array<{ id: string; text: string; explanation: string }>;
  correct_option_id: string;
  question_key: string;
  section_anchor: string;
  sort_order: number;
}

function blankFields(): EditorFields {
  return {
    prompt: "",
    options: [
      { id: "a", text: "", explanation: "" },
      { id: "b", text: "", explanation: "" },
    ],
    correct_option_id: "a",
    question_key: "",
    section_anchor: "",
    sort_order: 0,
  };
}

function fieldsFromQuestion(q: AuthorQuestion): EditorFields {
  return {
    prompt: q.prompt,
    options: q.options.map((o) => ({
      id: o.id,
      text: o.text,
      explanation: o.explanation ?? "",
    })),
    correct_option_id: q.correct_option_id,
    question_key: q.question_key,
    section_anchor: q.section_anchor ?? "",
    sort_order: q.sort_order,
  };
}

function coveragePill(c: ObligationCoverage): { className: string; label: string } {
  const n = c.activeCount;
  if (n === 0) return { className: "kf-pill kf-pill--warn", label: "none yet" };
  if (n === 1) return { className: "kf-pill kf-pill--warn", label: `${n} - needs more` };
  if (n <= 4) return { className: "kf-pill kf-pill--good", label: `${n} of 4 max` };
  return { className: "kf-pill kf-pill--warn", label: `${n} - trim to 4` };
}

function statusPill(s: AuthorQuestion["status"]) {
  if (s === "approved") return { className: "kf-pill kf-pill--good", label: "approved" };
  if (s === "retired") return { className: "kf-pill kf-pill--muted", label: "retired" };
  return { className: "kf-pill kf-pill--warn", label: "draft" };
}

export function QuestionsAdmin({ data }: Props) {
  const router = useRouter();

  // Default selection: first obligation in catalog with any questions,
  // else the first obligation. Falls through to "none" when catalog
  // is empty.
  const defaultModKey = useMemo(() => {
    if (data.coverage.length === 0) return "";
    const withAny = data.coverage.find((c) => c.activeCount > 0);
    const c = withAny ?? data.coverage[0];
    return moduleKey(c.doc_id, c.obligation_key, c.doc_version);
  }, [data.coverage]);

  const [selectedModKey, setSelectedModKey] = useState<string>(defaultModKey);
  const [selection, setSelection] = useState<Selection>({ kind: "none" });
  const [fields, setFields] = useState<EditorFields>(blankFields);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const selectedCoverage = useMemo(
    () =>
      data.coverage.find(
        (c) => moduleKey(c.doc_id, c.obligation_key, c.doc_version) === selectedModKey,
      ) ?? null,
    [data.coverage, selectedModKey],
  );

  const selectedQuestions = useMemo<AuthorQuestion[]>(() => {
    if (!selectedModKey) return [];
    const list = data.questionsByModule[selectedModKey] || [];
    // Hide retired from the active list; retired is terminal and has
    // no author action.
    return list.filter((q) => q.status !== "retired");
  }, [data.questionsByModule, selectedModKey]);

  const retiredCount = useMemo<number>(() => {
    if (!selectedModKey) return 0;
    const list = data.questionsByModule[selectedModKey] || [];
    return list.filter((q) => q.status === "retired").length;
  }, [data.questionsByModule, selectedModKey]);

  const selectedQuestion = useMemo<AuthorQuestion | null>(() => {
    if (selection.kind !== "existing") return null;
    const list = data.questionsByModule[selectedModKey] || [];
    return list.find((q) => q.question_id === selection.questionId) ?? null;
  }, [selection, data.questionsByModule, selectedModKey]);

  const selectModule = useCallback((key: string) => {
    setSelectedModKey(key);
    setSelection({ kind: "none" });
    setErrors([]);
  }, []);

  const pickQuestion = useCallback(
    (q: AuthorQuestion) => {
      setSelection({ kind: "existing", questionId: q.question_id });
      setFields(fieldsFromQuestion(q));
      setErrors([]);
    },
    [],
  );

  const startNew = useCallback(() => {
    if (!selectedModKey) return;
    setSelection({ kind: "new", modKey: selectedModKey });
    setFields(blankFields());
    setErrors([]);
  }, [selectedModKey]);

  const refresh = useCallback(() => router.refresh(), [router]);

  const postJson = useCallback(
    async (url: string, body: unknown) => {
      setSubmitting(true);
      setErrors([]);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: body != null ? JSON.stringify(body) : undefined,
        });
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          detail?: string;
          details?: string[];
        };
        if (!res.ok) {
          const errs = Array.isArray(data.details) ? data.details : [];
          const top = data.detail || data.error || `HTTP ${res.status}`;
          setErrors(errs.length > 0 ? errs : [top]);
          setSubmitting(false);
          return false;
        }
        setSubmitting(false);
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setErrors([msg]);
        setSubmitting(false);
        return false;
      }
    },
    [],
  );

  const bodyForUpdate = useMemo(() => {
    return {
      prompt: fields.prompt,
      options: fields.options.map((o) => ({
        id: o.id,
        text: o.text,
        explanation: o.explanation || undefined,
      })),
      correct_option_id: fields.correct_option_id,
      section_anchor: fields.section_anchor || null,
      sort_order: Number(fields.sort_order) || 0,
    };
  }, [fields]);

  const createQuestion = useCallback(async () => {
    if (selection.kind !== "new" || !selectedCoverage) return;
    const body = {
      ...bodyForUpdate,
      doc_id: selectedCoverage.doc_id,
      obligation_key: selectedCoverage.obligation_key,
      doc_version: selectedCoverage.doc_version,
      question_key: fields.question_key,
    };
    const ok = await postJson("/api/academy/admin/questions", body);
    if (ok) {
      setSelection({ kind: "none" });
      refresh();
    }
  }, [selection, selectedCoverage, bodyForUpdate, fields.question_key, postJson, refresh]);

  const saveInPlace = useCallback(async () => {
    if (selection.kind !== "existing") return;
    const ok = await postJson(
      `/api/academy/admin/questions/${selection.questionId}/save`,
      bodyForUpdate,
    );
    if (ok) refresh();
  }, [selection, bodyForUpdate, postJson, refresh]);

  const saveAsDraft = useCallback(async () => {
    if (selection.kind !== "existing") return;
    const ok = await postJson(
      `/api/academy/admin/questions/${selection.questionId}/save-as-draft`,
      bodyForUpdate,
    );
    if (ok) refresh();
  }, [selection, bodyForUpdate, postJson, refresh]);

  const approve = useCallback(async () => {
    if (selection.kind !== "existing") return;
    const ok = await postJson(
      `/api/academy/admin/questions/${selection.questionId}/approve`,
      null,
    );
    if (ok) refresh();
  }, [selection, postJson, refresh]);

  const retire = useCallback(async () => {
    if (selection.kind !== "existing") return;
    if (
      !window.confirm(
        "Retire this question? It stops being served to learners. Retiring is terminal - there is no un-retire.",
      )
    ) {
      return;
    }
    const ok = await postJson(
      `/api/academy/admin/questions/${selection.questionId}/retire`,
      null,
    );
    if (ok) {
      setSelection({ kind: "none" });
      refresh();
    }
  }, [selection, postJson, refresh]);

  // Band facts match the V7 render's top strip + the cover-the-zeroes
  // title. When every module is covered, the band says so.
  const bandTitle =
    data.totals.modulesWithZero > 0
      ? data.totals.modulesWithZero === 1
        ? `One module has no questions yet`
        : `${data.totals.modulesWithZero} modules have no questions yet`
      : data.totals.modulesInCatalog > 0
        ? `Every module has questions`
        : `No modules in the catalog yet`;
  const bandKick =
    data.totals.modulesInCatalog > 0
      ? `Two to four per module. Learners only ever see approved questions - drafts and retired are invisible to them.`
      : `Obligations seed into the catalog as documents land in the Library.`;
  const bandFacts: AcademyBandFact[] = [
    { label: "Approved", value: data.totals.approvedTotal },
    { label: "Drafts", value: data.totals.draftTotal },
    { label: "Modules", value: data.totals.modulesInCatalog },
  ];
  const phoneStatus =
    data.totals.modulesInCatalog > 0
      ? `${data.totals.approvedTotal} approved, ${data.totals.draftTotal} draft across ${data.totals.modulesInCatalog} modules`
      : "No modules in the catalog yet";

  const hasRetiredBeyondFilter = retiredCount > 0;

  return (
    <div className="kf-admin">
      <AcademyBand
        eyebrow="Admin"
        title={bandTitle}
        kick={bandKick}
        facts={bandFacts}
        actionSlot={
          <button
            type="button"
            className="kf-btn kf-btn--on-navy"
            onClick={startNew}
            disabled={!selectedCoverage || selection.kind === "new"}
            aria-label="New question"
          >
            <Plus size={14} strokeWidth={1.5} />
            <span>New question</span>
          </button>
        }
      />
      <p className="kf-pstatus" aria-label="Status">{phoneStatus}</p>

      <div className="kf-qed">
        <section className="kf-qed__list" aria-label="Modules in the catalog">
          <header className="kf-qed__list-head">
            <h3 className="kf-qed__list-title">Modules</h3>
            <span className="kf-qed__list-meta">two to four per module</span>
          </header>
          <ul className="kf-qed__docs">
            {data.coverage.length === 0 ? (
              <li className="kf-qed__empty">
                No obligations in the catalog yet.
              </li>
            ) : (
              data.coverage.map((c) => {
                const key = moduleKey(c.doc_id, c.obligation_key, c.doc_version);
                const on = key === selectedModKey;
                const pill = coveragePill(c);
                return (
                  <li key={key}>
                    <button
                      type="button"
                      className={
                        "kf-qdoc" + (on ? " kf-qdoc--on" : "")
                      }
                      onClick={() => selectModule(key)}
                      aria-pressed={on}
                    >
                      <span className="kf-qdoc__text">
                        <span className="kf-qdoc__title">{c.doc_title}</span>
                        <span className="kf-qdoc__sub">
                          {c.obligation_key} - v{c.doc_version}
                        </span>
                      </span>
                      <span className={pill.className}>{pill.label}</span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>

          {selectedCoverage ? (
            <>
              <header className="kf-qed__list-head" style={{ marginTop: "var(--sp-sp-4)" }}>
                <h3 className="kf-qed__list-title">
                  Questions on {selectedCoverage.obligation_key}
                </h3>
                <span className="kf-qed__list-meta">v{selectedCoverage.doc_version}</span>
              </header>
              <ul className="kf-qed__docs">
                {selectedQuestions.length === 0 ? (
                  <li className="kf-qed__empty">
                    No active questions on this module yet. Click <em>New question</em> to start.
                  </li>
                ) : (
                  selectedQuestions.map((q) => {
                    const on =
                      selection.kind === "existing" && selection.questionId === q.question_id;
                    const pill = statusPill(q.status);
                    return (
                      <li key={q.question_id}>
                        <button
                          type="button"
                          className={"kf-qsect" + (on ? " kf-qsect--on" : "")}
                          onClick={() => pickQuestion(q)}
                          aria-pressed={on}
                        >
                          <span className="kf-qsect__key">{q.question_key}</span>
                          <span className="kf-qsect__prompt">
                            {q.prompt || <em>(no prompt yet)</em>}
                          </span>
                          <span className={pill.className}>{pill.label}</span>
                        </button>
                      </li>
                    );
                  })
                )}
                {hasRetiredBeyondFilter ? (
                  <li className="kf-qed__meta-line">
                    {retiredCount} retired question{retiredCount === 1 ? "" : "s"} not shown.
                  </li>
                ) : null}
              </ul>
            </>
          ) : null}
        </section>

        <section className="kf-qed__editor" aria-label="Editor">
          {selection.kind === "none" ? (
            <EmptyEditor
              hasModule={!!selectedCoverage}
              onNew={startNew}
              newDisabled={!selectedCoverage}
            />
          ) : (
            <Editor
              mode={selection.kind}
              question={selectedQuestion}
              coverage={selectedCoverage}
              fields={fields}
              setFields={setFields}
              submitting={submitting}
              errors={errors}
              onCreate={createQuestion}
              onSave={saveInPlace}
              onSaveAsDraft={saveAsDraft}
              onApprove={approve}
              onRetire={retire}
              onCancel={() => {
                setSelection({ kind: "none" });
                setErrors([]);
              }}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function EmptyEditor({
  hasModule,
  onNew,
  newDisabled,
}: {
  hasModule: boolean;
  onNew: () => void;
  newDisabled: boolean;
}) {
  return (
    <div className="kf-qed__empty-editor">
      <h3 className="kf-qed__editor-title">Pick a question to edit</h3>
      <p className="kf-qed__editor-sub">
        {hasModule
          ? "Pick a question on the left, or write a new one for this module."
          : "Pick a module on the left to start authoring."}
      </p>
      <div className="kf-qed__editor-actions">
        <button
          type="button"
          className="kf-btn"
          onClick={onNew}
          disabled={newDisabled || !hasModule}
        >
          <Plus size={14} strokeWidth={1.5} />
          <span>New question</span>
        </button>
      </div>
    </div>
  );
}

function Editor({
  mode,
  question,
  coverage,
  fields,
  setFields,
  submitting,
  errors,
  onCreate,
  onSave,
  onSaveAsDraft,
  onApprove,
  onRetire,
  onCancel,
}: {
  mode: "existing" | "new";
  question: AuthorQuestion | null;
  coverage: ObligationCoverage | null;
  fields: EditorFields;
  setFields: (f: EditorFields) => void;
  submitting: boolean;
  errors: string[];
  onCreate: () => void;
  onSave: () => void;
  onSaveAsDraft: () => void;
  onApprove: () => void;
  onRetire: () => void;
  onCancel: () => void;
}) {
  const isApproved = question?.status === "approved";
  const isRetired = question?.status === "retired";
  const statusChip = question
    ? statusPill(question.status)
    : { className: "kf-pill kf-pill--warn", label: "new draft" };

  const updateOption = (i: number, patch: Partial<EditorFields["options"][number]>) => {
    const next = fields.options.map((o, idx) => (idx === i ? { ...o, ...patch } : o));
    setFields({ ...fields, options: next });
  };
  const setCorrect = (id: string) => {
    setFields({ ...fields, correct_option_id: id });
  };
  const addOption = () => {
    if (fields.options.length >= 4) return;
    const used = new Set(fields.options.map((o) => o.id));
    const alpha = ["a", "b", "c", "d"];
    const nextId = alpha.find((x) => !used.has(x)) || `opt${fields.options.length + 1}`;
    setFields({
      ...fields,
      options: [...fields.options, { id: nextId, text: "", explanation: "" }],
    });
  };
  const removeOption = (i: number) => {
    if (fields.options.length <= 2) return;
    const removed = fields.options[i];
    const next = fields.options.filter((_, idx) => idx !== i);
    const stillValid = next.some((o) => o.id === fields.correct_option_id);
    setFields({
      ...fields,
      options: next,
      correct_option_id: stillValid
        ? fields.correct_option_id
        : removed.id === fields.correct_option_id
          ? next[0].id
          : fields.correct_option_id,
    });
  };

  const moduleLabel = coverage
    ? `${coverage.doc_title} - ${coverage.obligation_key} v${coverage.doc_version}`
    : "";

  return (
    <div className="kf-qed__form">
      <header className="kf-qed__form-head">
        <h3 className="kf-qed__form-title">
          {mode === "new" ? "New question" : "Edit question"}
        </h3>
        <div className="kf-qed__form-status">
          <span className={statusChip.className}>{statusChip.label}</span>
          {mode === "existing" && !isRetired ? (
            <button
              type="button"
              className="kf-btn kf-btn--ghost"
              onClick={onRetire}
              disabled={submitting}
              aria-label="Retire question"
            >
              <Archive size={14} strokeWidth={1.5} />
              <span>Retire</span>
            </button>
          ) : null}
        </div>
      </header>

      {coverage ? (
        <p className="kf-qed__form-mod" aria-label="Module">
          {moduleLabel}
        </p>
      ) : null}

      {isApproved ? (
        <p className="kf-qed__form-note kf-qed__form-note--info">
          This question is live - learners see it. <strong>Save</strong> is disabled
          so a live question cannot be rewritten mid-attempt. Use{" "}
          <strong>Save as draft</strong> to edit it; that demotes it to draft in the
          same write so no learner is served the edited version until someone approves
          it again.
        </p>
      ) : null}

      <div className="kf-field">
        <label className="kf-field__label" htmlFor="q-prompt">Question</label>
        <textarea
          id="q-prompt"
          className="kf-textarea kf-qed__ta--prompt"
          value={fields.prompt}
          onChange={(e) => setFields({ ...fields, prompt: e.target.value })}
          placeholder="What must someone know to hold the standard here?"
          spellCheck
        />
      </div>

      {mode === "new" ? (
        <div className="kf-field__row">
          <div className="kf-field">
            <label className="kf-field__label" htmlFor="q-key">
              Question key (stable slug)
            </label>
            <input
              id="q-key"
              className="kf-input"
              type="text"
              value={fields.question_key}
              onChange={(e) =>
                setFields({ ...fields, question_key: e.target.value.trim() })
              }
              placeholder="hospitality-what-we-mean-1"
              autoComplete="off"
              spellCheck={false}
            />
            <span className="kf-field__hint">
              Unique on this module. Letters, digits, dot, dash, underscore.
            </span>
          </div>
          <div className="kf-field">
            <label className="kf-field__label" htmlFor="q-sort">Sort order</label>
            <input
              id="q-sort"
              className="kf-input"
              type="number"
              min={0}
              value={fields.sort_order}
              onChange={(e) =>
                setFields({ ...fields, sort_order: Number(e.target.value) || 0 })
              }
            />
          </div>
        </div>
      ) : (
        <div className="kf-field__row">
          <div className="kf-field">
            <label className="kf-field__label">Question key</label>
            <div className="kf-qed__readonly">{fields.question_key}</div>
            <span className="kf-field__hint">
              Stable slug - not editable after creation.
            </span>
          </div>
          <div className="kf-field">
            <label className="kf-field__label" htmlFor="q-sort">Sort order</label>
            <input
              id="q-sort"
              className="kf-input"
              type="number"
              min={0}
              value={fields.sort_order}
              onChange={(e) =>
                setFields({ ...fields, sort_order: Number(e.target.value) || 0 })
              }
            />
          </div>
        </div>
      )}

      <div className="kf-field">
        <label className="kf-field__label" htmlFor="q-anchor">
          Section anchor (optional)
        </label>
        <input
          id="q-anchor"
          className="kf-input"
          type="text"
          value={fields.section_anchor}
          onChange={(e) => setFields({ ...fields, section_anchor: e.target.value })}
          placeholder="e.g. hospitality"
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div className="kf-field">
        <span className="kf-field__label">Answers - mark the right one</span>
        <div className="kf-qed__options" role="radiogroup" aria-label="Answers">
          {fields.options.map((o, i) => {
            const isCorrect = o.id === fields.correct_option_id;
            const letter = String.fromCharCode(65 + i);
            return (
              <div
                key={i}
                className={
                  "kf-qopt" + (isCorrect ? " kf-qopt--right" : "")
                }
              >
                <div className="kf-qopt__head">
                  <span className="kf-qopt__letter">{letter}</span>
                  <input
                    type="text"
                    className="kf-input kf-qopt__id"
                    value={o.id}
                    onChange={(e) => updateOption(i, { id: e.target.value.trim() })}
                    aria-label={`Option ${letter} id`}
                    placeholder="id"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className={
                      "kf-qopt__mark" + (isCorrect ? " kf-qopt__mark--on" : "")
                    }
                    onClick={() => setCorrect(o.id)}
                    aria-pressed={isCorrect}
                    aria-label={`Mark ${letter} as the right answer`}
                  >
                    <Check size={14} strokeWidth={1.5} />
                    <span>{isCorrect ? "Right answer" : "Mark as right"}</span>
                  </button>
                  {fields.options.length > 2 ? (
                    <button
                      type="button"
                      className="kf-btn kf-btn--ghost kf-qopt__rm"
                      onClick={() => removeOption(i)}
                      aria-label={`Remove option ${letter}`}
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
                <textarea
                  className="kf-textarea kf-qopt__text"
                  value={o.text}
                  onChange={(e) => updateOption(i, { text: e.target.value })}
                  placeholder="Answer text as the learner reads it."
                />
                <textarea
                  className="kf-textarea kf-qopt__expl"
                  value={o.explanation}
                  onChange={(e) => updateOption(i, { explanation: e.target.value })}
                  placeholder={
                    isCorrect
                      ? "What the learner reads when they get it right."
                      : "Corrective explanation when picked."
                  }
                />
              </div>
            );
          })}
        </div>
        {fields.options.length < 4 ? (
          <button
            type="button"
            className="kf-btn kf-btn--ghost"
            onClick={addOption}
            style={{ alignSelf: "flex-start", marginTop: "var(--sp-sp-2)" }}
          >
            <Plus size={14} strokeWidth={1.5} />
            <span>Add an answer</span>
          </button>
        ) : null}
      </div>

      <p className="kf-qed__form-note">
        The right answer never leaves the server. People see the question and the
        answers; grading happens on <code>/api/academy/check</code>, and every
        attempt is kept. Only approved questions are served.
      </p>

      {errors.length > 0 ? (
        <div className="kf-form-errors" role="alert">
          <strong>
            <AlertCircle
              size={14}
              strokeWidth={1.5}
              style={{ verticalAlign: "-2px", marginRight: 6 }}
            />
            Could not save:
          </strong>
          <ul>
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="kf-qed__form-foot">
        {mode === "new" ? (
          <>
            <button
              type="button"
              className="kf-btn kf-btn--ghost"
              onClick={onCancel}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="button"
              className="kf-btn"
              onClick={onCreate}
              disabled={submitting}
            >
              {submitting ? (
                <Loader2 size={14} strokeWidth={1.5} className="kf-spin" />
              ) : (
                <SaveIcon size={14} strokeWidth={1.5} />
              )}
              <span>Save draft</span>
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="kf-btn"
              onClick={onSave}
              disabled={submitting || isApproved || isRetired}
              aria-disabled={isApproved || isRetired}
              title={
                isApproved
                  ? "Save is disabled on approved questions. Use Save as draft."
                  : undefined
              }
            >
              {submitting ? (
                <Loader2 size={14} strokeWidth={1.5} className="kf-spin" />
              ) : (
                <SaveIcon size={14} strokeWidth={1.5} />
              )}
              <span>Save</span>
            </button>
            <button
              type="button"
              className="kf-btn kf-btn--ghost"
              onClick={onSaveAsDraft}
              disabled={submitting || isRetired}
            >
              <SaveIcon size={14} strokeWidth={1.5} />
              <span>Save as draft</span>
            </button>
            {!isApproved && !isRetired ? (
              <button
                type="button"
                className="kf-btn kf-btn--on-navy"
                onClick={onApprove}
                disabled={submitting}
              >
                <CheckCircle2 size={14} strokeWidth={1.5} />
                <span>Approve</span>
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
