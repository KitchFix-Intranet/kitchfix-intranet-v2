"use client";

// R-AC13 reader. Server page hands `body: ModuleBody` across the
// RSC boundary - pure data, no function props. Everything client-side
// in this file.
//
// Pages: 0..steps.length-1 are content pages; the virtual page at
// steps.length is the sign page. Next is never locked (reading is
// free); only signing waits for the checks.
//
// Checks POST /api/academy/check. Progress POSTS on page change.
// Sign POSTs /api/academy/sign with a client-generated attestationId
// that is stable for this Reader instance - retries reuse it so the
// server's PK-conflict idempotency works.
//
// After a successful sign the pane is replaced by the Receipt (R-AC17)
// at full size, one entrance animation, then plain next-step buttons.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Check as CheckIcon,
  ChevronDown,
  List as ListIcon,
  X,
} from "lucide-react";
import type { ModuleBody, Step, WireQuestion } from "@/lib/academy/module";
import { Receipt } from "./Receipt";
import {
  buildAttestationSentence,
  moduleTitleForAttestation,
} from "@/lib/academy/attestation";

// Module title derivation lives in @/lib/academy/attestation and is
// the single source of truth shared by the sign route, the certificate
// renderer, and this live preview. For multi-section obligations the
// title is the module NAME (derived from obligation.description's lead
// clause) rather than the first section heading; for single-section
// obligations the section heading stands. See PR #4.

type Option = { id: string; text: string; explanation?: string };

type AttemptState =
  | { kind: "idle" }
  | { kind: "submitting"; optionId: string }
  | { kind: "correct"; optionId: string; explanation: string }
  | { kind: "wrong"; optionId: string; explanation: string };

type SignState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; detail: string }
  | { kind: "success"; attestation: SignedAttestation };

type SignedAttestation = {
  attestation_id: string;
  certificate_serial: string | null;
  signed_at: string | null;
  typed_name: string | null;
  doc_id: string;
  obligation_key: string;
  doc_version: string | number | null;
};

type Props = {
  body: ModuleBody;
};

function normName(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

export function Reader({ body }: Props) {
  const router = useRouter();
  const requirementId = String(body.requirement.requirement_id);
  const steps: Step[] = body.steps;
  const totalContent = steps.length;
  // The virtual sign page sits at index === totalContent.
  const signIndex = totalContent;

  // Mount at the furthest step; if the engine's furthest_step_index is
  // ahead of totalContent, clamp into [0, signIndex].
  const initialIndex = Math.min(Math.max(body.progress.furthest_step_index, 0), signIndex);
  const [index, setIndex] = useState<number>(initialIndex);

  // Correct-answer memory. Seeded from the engine so a resumed reader
  // does not re-answer questions already passed, and ready-to-sign
  // stays consistent with the server after a reload.
  const [correctIds, setCorrectIds] = useState<Set<string | number>>(
    () => new Set(body.progress.all_correct_ids.map((id) => id)),
  );
  // Per-question attempt state for the UI verdict display.
  const [attempts, setAttempts] = useState<Record<string, AttemptState>>({});

  // Sections menu open/close.
  const [menuOpen, setMenuOpen] = useState(false);

  // Progress POST throttling.
  const seenKeysRef = useRef<Set<string>>(new Set(body.progress.sections_seen));
  const progressFailedRef = useRef(false);
  const [progressFailed, setProgressFailed] = useState(false);

  // Session clock for timeSpentSeconds (floor at the server's recorded
  // value so a resume does not shrink the recorded time).
  const mountedAtRef = useRef<number>(Date.now());
  const baseTimeRef = useRef<number>(body.progress.time_spent_seconds);
  const timeSpentSeconds = (): number =>
    baseTimeRef.current + Math.round((Date.now() - mountedAtRef.current) / 1000);

  // Sign state.
  const [typedName, setTypedName] = useState<string>("");
  const [signState, setSignState] = useState<SignState>({ kind: "idle" });

  // Stable client-generated UUID for this Reader instance. useRef so
  // the lazy init happens once per client mount; SSR renders no DOM
  // for the sign form, so there is no hydration mismatch to worry
  // about on this value (it is read only when the user focuses the
  // sign block).
  const attestationIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!attestationIdRef.current) {
      attestationIdRef.current =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : fallbackUUID();
    }
  }, []);

  // Was the attestation already written in a prior session? If so, the
  // module route returns the attestation; show the "already signed"
  // post-pane rather than inviting a double-sign.
  const existingAttestation = body.attestation;
  const [postSignAttestation, setPostSignAttestation] = useState<SignedAttestation | null>(
    existingAttestation
      ? {
          attestation_id: String(existingAttestation.attestation_id),
          certificate_serial: existingAttestation.certificate_serial,
          signed_at: existingAttestation.signed_at,
          typed_name: existingAttestation.typed_name,
          doc_id: existingAttestation.doc_id,
          obligation_key: existingAttestation.obligation_key,
          doc_version: existingAttestation.doc_version,
        }
      : null,
  );

  // Minutes-left header number. Count only steps not yet past.
  const minutesLeft = useMemo(() => {
    const remaining = steps.slice(index).reduce((acc, s) => acc + (s.estMinutes || 0), 0);
    return Math.max(0, remaining);
  }, [steps, index]);

  const totalMinutes = useMemo(
    () => steps.reduce((acc, s) => acc + (s.estMinutes || 0), 0),
    [steps],
  );

  const allChecksPassed = useMemo(() => {
    if (body.questions.length === 0) return true;
    return body.questions.every((q) => correctIds.has(q.question_id));
  }, [body.questions, correctIds]);

  // R-AC23: Sign is unreachable until every section has been displayed
  // (user navigated to it at least once in any session) AND every
  // check is right. Reading stays free; Next stays free; only Sign
  // waits. "Seen" is tracked server-side in academy_module_progress
  // and seeded here from body.progress.sections_seen; new steps in
  // this session land into seenKeysRef on step change.
  // Track seen-keys as a size count so useMemo invalidates on change.
  const [seenCount, setSeenCount] = useState<number>(() => seenKeysRef.current.size);
  const allSectionsSeen = useMemo(() => {
    if (steps.length === 0) return false;
    return steps.every((s) => seenKeysRef.current.has(s.key));
  }, [steps, seenCount]);

  // Progress POST on step change (debounced-ish: fire-and-forget,
  // skipping until values actually change).
  const sendProgress = useCallback(
    async (keys: string[]) => {
      try {
        const res = await fetch("/api/academy/progress", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requirementId,
            sectionsSeen: keys,
            timeSpentSeconds: timeSpentSeconds(),
          }),
        });
        if (!res.ok) {
          progressFailedRef.current = true;
          setProgressFailed(true);
        } else if (progressFailedRef.current) {
          progressFailedRef.current = false;
          setProgressFailed(false);
        }
      } catch {
        progressFailedRef.current = true;
        setProgressFailed(true);
      }
    },
    [requirementId],
  );

  // When the step changes, record the new step as seen and post.
  useEffect(() => {
    if (index >= signIndex) return;
    const step = steps[index];
    if (!step) return;
    if (seenKeysRef.current.has(step.key)) return;
    seenKeysRef.current.add(step.key);
    setSeenCount(seenKeysRef.current.size);
    void sendProgress(Array.from(seenKeysRef.current));
  }, [index, signIndex, steps, sendProgress]);

  // Record the initial mount's step (so a resume at step N still
  // reports step N as seen on this visit, extending time).
  useEffect(() => {
    const step = steps[initialIndex];
    if (step && !seenKeysRef.current.has(step.key)) {
      seenKeysRef.current.add(step.key);
      setSeenCount(seenKeysRef.current.size);
    }
    void sendProgress(Array.from(seenKeysRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goPrev = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);
  const goNext = useCallback(() => setIndex((i) => Math.min(signIndex, i + 1)), [signIndex]);

  // Compute the module title ONCE, via the shared derivation. Reuse
  // this value in the attestation preview, the pane header subline,
  // and (after a successful sign) the Receipt label - everywhere the
  // Reader surfaces a module name, so a multi-section module reads
  // the same string in every spot and matches what the server stores.
  const moduleTitle = useMemo(
    () =>
      moduleTitleForAttestation({
        sourceSection: body.obligation?.source_section ?? null,
        description: body.obligation?.description ?? null,
      }),
    [body.obligation?.source_section, body.obligation?.description],
  );

  const docContextSub = useMemo(() => {
    const version = body.requirement.doc_version ?? body.doc.version;
    const parts: string[] = [body.doc.id];
    if (version != null) parts.push(`v${version}`);
    if (moduleTitle) parts.push(moduleTitle);
    return parts.join(" - ");
  }, [body, moduleTitle]);

  const attestationSentence = useMemo(
    () =>
      buildAttestationSentence({
        displayName: body.viewer.displayName,
        moduleTitle: moduleTitle || null,
        documentTitle: body.doc.title || body.doc.id,
        version: body.requirement.doc_version ?? body.doc.version ?? null,
      }),
    [body, moduleTitle],
  );

  // Check POST handler. The route returns { correct, explanation }
  // for the SELECTED option only.
  const handleAnswer = useCallback(
    async (question: WireQuestion, optionId: string) => {
      const key = String(question.question_id);
      setAttempts((prev) => ({ ...prev, [key]: { kind: "submitting", optionId } }));
      try {
        const res = await fetch("/api/academy/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requirementId,
            questionId: question.question_id,
            selectedOptionId: optionId,
          }),
        });
        if (!res.ok) {
          setAttempts((prev) => ({
            ...prev,
            [key]: {
              kind: "wrong",
              optionId,
              explanation: "The answer did not save. Try again.",
            },
          }));
          return;
        }
        const data = (await res.json()) as { correct: boolean; explanation?: string };
        if (data.correct) {
          setCorrectIds((prev) => {
            const next = new Set(prev);
            next.add(question.question_id);
            return next;
          });
          setAttempts((prev) => ({
            ...prev,
            [key]: {
              kind: "correct",
              optionId,
              explanation: data.explanation ?? "Correct.",
            },
          }));
        } else {
          setAttempts((prev) => ({
            ...prev,
            [key]: {
              kind: "wrong",
              optionId,
              explanation: data.explanation ?? "Not quite.",
            },
          }));
        }
      } catch {
        setAttempts((prev) => ({
          ...prev,
          [key]: {
            kind: "wrong",
            optionId,
            explanation: "The answer did not save. Try again.",
          },
        }));
      }
    },
    [requirementId],
  );

  const handleRetryAnswer = useCallback((questionId: string | number) => {
    setAttempts((prev) => {
      const next = { ...prev };
      delete next[String(questionId)];
      return next;
    });
  }, []);

  // Sign POST handler.
  const handleSign = useCallback(async () => {
    if (signState.kind === "submitting") return;
    if (!attestationIdRef.current) return;
    if (normName(typedName) !== normName(body.viewer.displayName ?? "")) return;
    if (!allChecksPassed) return;
    // R-AC23: Sign is unreachable until every section has been
    // displayed. The server's Gate 6 is the authoritative check,
    // but we never submit a sign that we know will refuse.
    if (!allSectionsSeen) return;
    setSignState({ kind: "submitting" });
    try {
      const res = await fetch("/api/academy/sign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requirementId,
          attestationId: attestationIdRef.current,
          typedName: typedName.trim(),
          timeSpentSeconds: timeSpentSeconds(),
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          attestation: SignedAttestation;
        };
        setPostSignAttestation(data.attestation);
        setSignState({ kind: "success", attestation: data.attestation });
      } else {
        const data = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
        setSignState({
          kind: "error",
          detail: data.detail || data.error || `Signature did not save (status ${res.status}).`,
        });
      }
    } catch {
      setSignState({
        kind: "error",
        detail: "Network error. Nothing was signed; your place is kept.",
      });
    }
    // Note: on retry the SAME attestationIdRef is reused per the
    // idempotency contract. Do not generate a new one here.
  }, [signState.kind, typedName, body.viewer.displayName, allChecksPassed, allSectionsSeen, requirementId]);

  const firstOpenQuestion = useMemo(
    () => body.questions.find((q) => !correctIds.has(q.question_id)),
    [body.questions, correctIds],
  );
  const jumpToFirstOpenCheck = useCallback(() => {
    if (!firstOpenQuestion) return;
    const anchor = firstOpenQuestion.section_anchor;
    const targetIndex = steps.findIndex((s) => s.anchor === anchor);
    if (targetIndex >= 0) setIndex(targetIndex);
  }, [firstOpenQuestion, steps]);

  // R-AC23: no readable content -> guard state. No Sign anywhere.
  // The server's Gate 6 is authoritative, but the Reader never
  // offers Sign on a module whose doc body never rendered. The
  // guard names the document, explains the pause in plain words,
  // and sends the learner back to To do. No inline acknowledgement.
  const hasReadableContent = steps.length > 0 && body.content_html != null && body.content_html.replace(/<[^>]*>/g, "").replace(/\s+/g, "").length >= 20;
  if (!hasReadableContent && !postSignAttestation) {
    return (
      <div className="kf-sheet">
        <section className="kf-reader kf-reader--guard" aria-label="Reader paused">
          <header className="kf-reader__head">
            <div className="kf-reader__head-text">
              <h2 className="kf-reader__title">{body.doc.title}</h2>
              <p className="kf-reader__sub">{docContextSub}</p>
            </div>
          </header>
          <div className="kf-reader__body">
            <section className="kf-sign-open" aria-label="No readable content">
              <p className="kf-write-failed__title" style={{ color: "var(--sp-navy)" }}>
                This document is not ready to read yet
              </p>
              <p className="kf-write-failed__body">
                <strong>{body.doc.title}</strong> has nothing to display,
                so there is nothing to sign. Your record is unchanged.
                Try again later, or go back to your list.
              </p>
              <div style={{ display: "flex", justifyContent: "center", gap: "var(--sp-sp-2)" }}>
                <Link href="/academy" className="kf-btn kf-btn--primary">
                  <ArrowLeft size={16} strokeWidth={1.5} />
                  <span>Back to To do</span>
                </Link>
              </div>
            </section>
          </div>
        </section>
      </div>
    );
  }

  // After a successful sign (this instance) we swap the pane for the
  // Receipt. For a previously-signed requirement we also show the
  // Receipt rather than invite a double-sign.
  if (postSignAttestation) {
    return (
      <div className="kf-sheet">
        <section className="kf-reader kf-after-sign" aria-label="Signed">
          <div className="kf-reader__body">
            <Receipt
              size="full"
              docTitle={body.doc.title}
              moduleLabel={moduleTitle || body.doc.card_line}
              signedAt={postSignAttestation.signed_at}
              certificateSerial={postSignAttestation.certificate_serial}
              docVersion={postSignAttestation.doc_version}
              certificateHref={`/api/academy/certificate/${postSignAttestation.attestation_id}`}
            />
            <div className="kf-after-sign__next">
              <Link
                href={`/academy?signed=${encodeURIComponent(requirementId)}`}
                className="kf-btn kf-btn--primary"
              >
                <span>Back to To do</span>
              </Link>
              <Link href="/academy/done" className="kf-btn kf-btn--line">
                <span>Open Done</span>
              </Link>
            </div>
          </div>
        </section>
      </div>
    );
  }

  const onSignPage = index >= signIndex;
  const currentStep: Step | null = !onSignPage ? steps[index] ?? null : null;
  const currentQuestions: WireQuestion[] = currentStep
    ? body.questions.filter((q) =>
        currentStep.anchors.includes(q.section_anchor ?? "") ||
        q.section_anchor === currentStep.anchor,
      )
    : [];
  const progressRatio = totalContent === 0 ? 1 : Math.min(1, (onSignPage ? totalContent : index + 1) / (totalContent + 1));

  const typedNameMatches =
    typedName.trim().length > 0 &&
    normName(typedName) === normName(body.viewer.displayName ?? "");
  const signDisabled =
    signState.kind === "submitting" ||
    !allChecksPassed ||
    !allSectionsSeen ||
    !typedNameMatches ||
    attestationIdRef.current === null;
  const unseenSections = steps.filter((s) => !seenKeysRef.current.has(s.key)).length;

  // Sections rail row model, shared with the dropdown menu. Rail is
  // the primary surface at >1180; the dropdown is its one legitimate
  // fallback at <=1180 (R-AC25). Numbers show section state - ring
  // (unopened), green-filled (seen), dashed ring (Sign while locked),
  // green-filled check (Sign when reachable). V7 .contents--read.
  const sectionsRead = steps.filter((s) => seenKeysRef.current.has(s.key)).length;
  const signReady = allSectionsSeen && allChecksPassed;

  return (
    <div className="kf-sheet kf-reader-layout">
      <aside className="kf-reader-rail" aria-label="Sections">
        <div className="kf-reader-rail__head">
          <span className="kf-reader-rail__title">Sections</span>
          <span className="kf-reader-rail__count">
            {sectionsRead} of {steps.length} read
          </span>
        </div>
        <ul className="kf-reader-rail__list" role="menu">
          {steps.map((s, i) => {
            const seen = seenKeysRef.current.has(s.key);
            const isActive = i === index;
            const classes = ["kf-reader-rail__row"];
            if (isActive) classes.push("kf-reader-rail__row--active");
            if (seen) classes.push("kf-reader-rail__row--done");
            const checkCount = s.questionIds.length;
            // Per-section meta. V7 shows "N min" or "N min · check done".
            // We know the step's checks are passed when every question
            // anchored to this step has been correctly answered.
            const stepChecksPassed =
              checkCount > 0 &&
              body.questions
                .filter((q) =>
                  s.anchors.includes(q.section_anchor ?? "") ||
                  q.section_anchor === s.anchor,
                )
                .every((q) => correctIds.has(q.question_id));
            const metaBits: string[] = [`${s.estMinutes} min`];
            if (checkCount > 0) {
              metaBits.push(stepChecksPassed ? "check done" : "check open");
            }
            return (
              <li key={s.key} role="none">
                <button
                  type="button"
                  className={classes.join(" ")}
                  onClick={() => setIndex(i)}
                  role="menuitem"
                  title={s.anchor}
                >
                  <span className="kf-reader-rail__num" aria-hidden>
                    {seen ? "✓" : i + 1}
                  </span>
                  <span className="kf-reader-rail__row-title">{s.anchor}</span>
                  <span className="kf-reader-rail__row-meta">{metaBits.join(" · ")}</span>
                </button>
              </li>
            );
          })}
          <li role="none">
            <button
              type="button"
              className={`kf-reader-rail__row kf-reader-rail__row--sign${index === signIndex ? " kf-reader-rail__row--active" : ""}`}
              onClick={() => setIndex(signIndex)}
              aria-disabled={signReady ? "false" : "true"}
              role="menuitem"
            >
              <span className="kf-reader-rail__num" aria-hidden>
                {signReady ? "✓" : "·"}
              </span>
              <span className="kf-reader-rail__row-title">Sign</span>
              <span className="kf-reader-rail__row-meta">
                {signReady
                  ? "ready to sign"
                  : !allSectionsSeen
                    ? "sections open"
                    : "checks open"}
              </span>
            </button>
          </li>
        </ul>
      </aside>
      <section
        className="kf-reader"
        aria-label="Reader"
        style={{ ["--w" as never]: progressRatio }}
      >
        <header className="kf-reader__head">
          <div className="kf-reader__head-text">
            <h2 className="kf-reader__title">{body.doc.title}</h2>
            <p className="kf-reader__sub">{docContextSub}</p>
          </div>
          <div className="kf-reader__head-right">
            <span
              className="kf-reader__minutes"
              aria-label={`${minutesLeft} minutes left`}
              title={`${totalMinutes} minutes total`}
            >
              {minutesLeft} min
            </span>
            <button
              type="button"
              className="kf-btn kf-btn--soft kf-reader-sections-btn"
              onClick={() => setMenuOpen((v) => !v)}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
            >
              <ListIcon size={16} strokeWidth={1.5} />
              <span>Sections</span>
              <ChevronDown size={14} strokeWidth={1.5} />
            </button>
            {/* Save and exit. Progress is written as the learner moves
             * between sections (see /api/academy/progress), so there
             * is nothing to POST here - a plain Link back to the
             * To do list keeps the discipline that the Reader never
             * invents an endpoint for state the engine already saves.
             * 44px floor via the shared .kf-btn baseline. */}
            <Link href="/academy" className="kf-btn kf-btn--line kf-reader__save-exit">
              <span>Save and exit</span>
            </Link>
          </div>
        </header>

        {menuOpen ? (
          <SectionsMenu
            steps={steps}
            currentIndex={index}
            seenKeys={seenKeysRef.current}
            allChecksPassed={allChecksPassed}
            allSectionsSeen={allSectionsSeen}
            onPick={(i) => {
              setIndex(i);
              setMenuOpen(false);
            }}
            onClose={() => setMenuOpen(false)}
          />
        ) : null}

        <div className="kf-reader__progress" aria-hidden />

        <div className="kf-reader__body">
          {progressFailed ? (
            <div className="kf-write-failed" role="status" aria-live="polite">
              <p className="kf-write-failed__title">Your progress did not save</p>
              <p className="kf-write-failed__body">
                Your place is unchanged and nothing was signed. We will try again on the next step.
              </p>
            </div>
          ) : null}

          {!onSignPage && currentStep ? (
            <StepBody
              step={currentStep}
              questions={currentQuestions}
              attempts={attempts}
              correctIds={correctIds}
              onAnswer={handleAnswer}
              onRetry={handleRetryAnswer}
            />
          ) : (
            <SignBlock
              body={body}
              attestationSentence={attestationSentence}
              typedName={typedName}
              onTypedNameChange={setTypedName}
              typedNameMatches={typedNameMatches}
              allChecksPassed={allChecksPassed}
              openQuestionsCount={body.questions.length - correctIds.size}
              allSectionsSeen={allSectionsSeen}
              unseenSections={unseenSections}
              onBackToFirstUnseen={() => {
                const i = steps.findIndex((s) => !seenKeysRef.current.has(s.key));
                if (i >= 0) setIndex(i);
              }}
              signState={signState}
              signDisabled={signDisabled}
              onSign={handleSign}
              onBackToOpen={jumpToFirstOpenCheck}
            />
          )}
        </div>

        <footer className="kf-reader__foot">
          <button
            type="button"
            className="kf-btn kf-btn--line"
            onClick={goPrev}
            disabled={index === 0}
            aria-label="Previous section"
          >
            <ArrowLeft size={16} strokeWidth={1.5} />
            <span>Back</span>
          </button>
          <span className="kf-reader__counter" aria-live="polite">
            {onSignPage
              ? "Sign"
              : `${index + 1} of ${totalContent + 1}`}
          </span>
          <button
            type="button"
            className="kf-btn kf-btn--primary"
            onClick={goNext}
            disabled={onSignPage}
            aria-label={onSignPage ? "On the sign page" : "Next section"}
          >
            <span>Next</span>
            <ArrowRight size={16} strokeWidth={1.5} />
          </button>
        </footer>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------
// Internal client components
// ------------------------------------------------------------------

function StepBody({
  step,
  questions,
  attempts,
  correctIds,
  onAnswer,
  onRetry,
}: {
  step: Step;
  questions: WireQuestion[];
  attempts: Record<string, AttemptState>;
  correctIds: Set<string | number>;
  onAnswer: (q: WireQuestion, optionId: string) => void;
  onRetry: (questionId: string | number) => void;
}) {
  return (
    <>
      <h3 className="kf-reader__step-title">{step.anchor}</h3>
      <div
        className="kf-reader__prose"
        // The HTML is server-rendered from the authored content_html;
        // module.ts hands us the step's HTML slice unchanged. The
        // engine strips the leading <hN> heading from the first chunk
        // and keeps subsequent sub-heads. No user-authored HTML
        // enters here.
        dangerouslySetInnerHTML={{ __html: step.html }}
      />
      {questions.map((q) => {
        const key = String(q.question_id);
        const state: AttemptState = attempts[key] ?? { kind: "idle" };
        const alreadyPassed = correctIds.has(q.question_id);
        return (
          <CheckCard
            key={key}
            question={q}
            state={state}
            alreadyPassed={alreadyPassed}
            onAnswer={(optId) => onAnswer(q, optId)}
            onRetry={() => onRetry(q.question_id)}
          />
        );
      })}
    </>
  );
}

function CheckCard({
  question,
  state,
  alreadyPassed,
  onAnswer,
  onRetry,
}: {
  question: WireQuestion;
  state: AttemptState;
  alreadyPassed: boolean;
  onAnswer: (optionId: string) => void;
  onRetry: () => void;
}) {
  const options = Array.isArray(question.options) ? (question.options as Option[]) : [];
  const disable =
    state.kind === "submitting" ||
    state.kind === "correct" ||
    alreadyPassed;

  return (
    <section className="kf-check" aria-label="Comprehension check">
      <span className="kf-check__eyebrow">Comprehension check</span>
      <p className="kf-check__prompt">{question.prompt}</p>
      <div className="kf-check__options" role="radiogroup" aria-label="Options">
        {options.map((o, i) => {
          const isSelected = state.kind !== "idle" && (state as { optionId?: string }).optionId === o.id;
          const classes = ["kf-check__opt"];
          if (isSelected && state.kind === "correct") classes.push("kf-check__opt--correct");
          if (isSelected && state.kind === "wrong") classes.push("kf-check__opt--wrong");
          return (
            <button
              key={o.id}
              type="button"
              className={classes.join(" ")}
              onClick={() => onAnswer(o.id)}
              disabled={disable}
              aria-pressed={isSelected}
            >
              <span className="kf-check__opt-ltr" aria-hidden>
                {String.fromCharCode(65 + i)}
              </span>
              <span>{o.text}</span>
            </button>
          );
        })}
      </div>
      {state.kind === "correct" || alreadyPassed ? (
        <p className="kf-check__verdict kf-check__verdict--correct" role="status">
          <CheckIcon size={14} strokeWidth={2} /> {state.kind === "correct" ? state.explanation : "You answered this correctly earlier."}
        </p>
      ) : state.kind === "wrong" ? (
        <>
          <p className="kf-check__verdict kf-check__verdict--wrong" role="status">
            {state.explanation}
          </p>
          <div className="kf-write-failed__row">
            <button type="button" className="kf-btn kf-btn--soft" onClick={onRetry}>
              Answer again
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}

function SectionsMenu({
  steps,
  currentIndex,
  seenKeys,
  allChecksPassed,
  allSectionsSeen,
  onPick,
  onClose,
}: {
  steps: Step[];
  currentIndex: number;
  seenKeys: Set<string>;
  allChecksPassed: boolean;
  allSectionsSeen: boolean;
  onPick: (index: number) => void;
  onClose: () => void;
}) {
  const signIndex = steps.length;
  const signReady = allSectionsSeen && allChecksPassed;
  const signMeta = signReady
    ? "Ready"
    : !allSectionsSeen
      ? "Sections open"
      : "Checks open";
  return (
    <ul className="kf-sections" aria-label="Sections menu" role="menu">
      {steps.map((s, i) => {
        const seen = seenKeys.has(s.key);
        const isActive = i === currentIndex;
        const classes = ["kf-sections__item"];
        if (isActive) classes.push("kf-sections__item--active");
        else if (seen) classes.push("kf-sections__item--seen");
        return (
          <li key={s.key} role="none">
            <button
              type="button"
              className={classes.join(" ")}
              onClick={() => onPick(i)}
              role="menuitem"
            >
              <span className="kf-sections__dot" aria-hidden />
              <span className="kf-sections__label">{s.anchor}</span>
              <span className="kf-sections__meta">
                {s.estMinutes} min{s.questionIds.length > 0 ? ` - ${s.questionIds.length} check${s.questionIds.length === 1 ? "" : "s"}` : ""}
              </span>
            </button>
          </li>
        );
      })}
      <li role="none">
        <button
          type="button"
          className={`kf-sections__item${currentIndex === signIndex ? " kf-sections__item--active" : ""}`}
          onClick={() => onPick(signIndex)}
          role="menuitem"
        >
          <span className="kf-sections__dot" aria-hidden />
          <span className="kf-sections__label">Sign</span>
          <span className="kf-sections__meta">{signMeta}</span>
        </button>
      </li>
      <li role="none" style={{ marginTop: "var(--sp-sp-1)" }}>
        <button
          type="button"
          className="kf-sections__item"
          onClick={onClose}
          role="menuitem"
          aria-label="Close sections menu"
        >
          <span aria-hidden style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 24, height: 24 }}>
            <X size={16} strokeWidth={1.5} />
          </span>
          <span className="kf-sections__label">Close</span>
          <span className="kf-sections__meta" />
        </button>
      </li>
    </ul>
  );
}

function SignBlock({
  body,
  attestationSentence,
  typedName,
  onTypedNameChange,
  typedNameMatches,
  allChecksPassed,
  openQuestionsCount,
  allSectionsSeen,
  unseenSections,
  onBackToFirstUnseen,
  signState,
  signDisabled,
  onSign,
  onBackToOpen,
}: {
  body: ModuleBody;
  attestationSentence: string;
  typedName: string;
  onTypedNameChange: (v: string) => void;
  typedNameMatches: boolean;
  allChecksPassed: boolean;
  openQuestionsCount: number;
  allSectionsSeen: boolean;
  unseenSections: number;
  onBackToFirstUnseen: () => void;
  signState: SignState;
  signDisabled: boolean;
  onSign: () => void;
  onBackToOpen: () => void;
}) {
  const displayName = body.viewer.displayName ?? "";

  // R-AC23: sections first, checks second. If the learner hasn't
  // navigated to every section yet, that is what blocks Sign - and
  // the message names it plainly.
  if (!allSectionsSeen) {
    return (
      <div className="kf-sign-open" aria-label="Sections open">
        <p className="kf-write-failed__title" style={{ color: "var(--sp-navy)" }}>
          You have {unseenSections} section{unseenSections === 1 ? "" : "s"} left to read
        </p>
        <p className="kf-write-failed__body">
          Signing waits until every section has been displayed. Reading is free - go back to the first one you have not opened.
        </p>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <button type="button" className="kf-btn kf-btn--primary" onClick={onBackToFirstUnseen}>
            <ArrowLeft size={16} strokeWidth={1.5} />
            <span>Open first unread section</span>
          </button>
        </div>
      </div>
    );
  }

  if (!allChecksPassed) {
    return (
      <div className="kf-sign-open" aria-label="Checks open">
        <p className="kf-write-failed__title" style={{ color: "var(--sp-navy)" }}>
          You have {openQuestionsCount} check{openQuestionsCount === 1 ? "" : "s"} to answer
        </p>
        <p className="kf-write-failed__body">
          Signing waits for every check to be answered correctly. Reading is free - jump back to the first open one.
        </p>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <button type="button" className="kf-btn kf-btn--primary" onClick={onBackToOpen}>
            <ArrowLeft size={16} strokeWidth={1.5} />
            <span>Open first check</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <section className="kf-sign" aria-label="Sign">
      <p className="kf-sign__identity">
        <span>Signing as</span>
        <span className="kf-sign__identity-who">{displayName || "You"}</span>
        <span aria-hidden style={{ color: "var(--sp-line)" }}>-</span>
        <span>Not you?</span>
        <a href="/api/auth/signout" className="kf-sign__identity-switch">
          Switch
        </a>
      </p>
      <p className="kf-sign__sentence">{attestationSentence}</p>
      <label className="kf-sign__field">
        <span className="kf-sign__label">Type your name to sign</span>
        <input
          className="kf-sign__input"
          type="text"
          autoComplete="off"
          value={typedName}
          onChange={(e) => onTypedNameChange(e.target.value)}
          placeholder={displayName}
          aria-describedby="kf-sign-hint"
        />
        <span id="kf-sign-hint" className="kf-sign__hint">
          Case does not matter. Must match the name on your account.
        </span>
      </label>
      {signState.kind === "error" ? (
        <div className="kf-write-failed" role="alert" aria-live="assertive">
          <p className="kf-write-failed__title">The signature did not save</p>
          <p className="kf-write-failed__body">
            {signState.detail} Nothing was signed, your place is kept.
          </p>
          <div className="kf-write-failed__row">
            <button type="button" className="kf-btn kf-btn--primary" onClick={onSign}>
              Try again
            </button>
            <Link href="/academy" className="kf-btn kf-btn--line">
              Back to To do
            </Link>
          </div>
        </div>
      ) : null}
      <div className="kf-sign__row">
        <button
          type="button"
          className={`kf-btn kf-btn--primary kf-sign__cta${signState.kind === "submitting" ? " is-busy" : ""}`}
          onClick={onSign}
          disabled={signDisabled}
          aria-label="Sign"
        >
          {signState.kind === "submitting" ? "Signing..." : "Sign"}
        </button>
      </div>
      {!typedNameMatches ? (
        <p className="kf-sign__hint" style={{ textAlign: "right" }}>
          Type your name exactly as it appears on your account to enable Sign.
        </p>
      ) : null}
    </section>
  );
}

// Browser crypto.randomUUID polyfill for very old browsers. Modern
// browsers and Node 18+ have it; this is only here so a stale device
// does not strand the user.
function fallbackUUID(): string {
  const b = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(b);
  } else {
    for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  }
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0"));
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
}
