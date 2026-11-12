"use client";

// PAF flow. One client component orchestrates the four steps and
// autosaves Details. The URL holds the step + the draft id so
// Back works and a reload keeps the viewer on the right step.
//
// Query params (produced by this component):
//   ?step=who|what|details|check
//   ?for=<worker_id>     (set when the user picks a person; mirrors
//                        the entry path from a person card)
//   ?draft=<uuid>        (set after the first autosave create)
//
// Autosave rules:
//   - A draft is created the FIRST TIME the sender changes a field
//     on Details. From then on each change is a debounced update.
//   - "Save and exit" fires on Details only, saves if dirty, and
//     navigates to /people.
//   - Preview (viewer.previewOf !== null) never autosaves and the
//     Save-and-exit button is disabled with one line of caption.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { ChevronLeft, ArrowRight } from "lucide-react";
import { Stepper } from "./Stepper";
import { WhoStep } from "./WhoStep";
import { WhatStep, type PafAction } from "./WhatStep";
import { DetailsStep } from "./DetailsStep";
import { CheckStep, type WhoSeesItView } from "./CheckStep";
import type { SelfRosterPerson, SiteNavEntry, SitePanel } from "@/lib/people/types";

type Step = "who" | "what" | "details" | "check";

type Props = {
  // Initial state hydrated from the server (draft or ?for=).
  initial: {
    step: Step;
    draftId: string | null;
    personWorkerId: string | null;
    personName: string | null;
    personAccountKey: string | null;
    action: PafAction | null;
    amount: string;
    effectiveDate: string;
    explanation: string;
  };
  // Team data for Who.
  team: {
    selfRow: SelfRosterPerson | null;
    sites: SiteNavEntry[];
    panels: Record<string, SitePanel>;
    defaultSiteKey: string;
    viewerWorkerId: string;
    singleSiteView: boolean;
  };
  // For Check.
  whoSeesIt: WhoSeesItView;
  // Preview mode: autosave disabled, Save-and-exit disabled.
  isPreview: boolean;
  // When preview, the ?as= value to carry into any URL.
  asWorkerId: string | null;
};

type Missing = { amount: boolean; effectiveDate: boolean; explanation: boolean };

function stepIndex(step: Step): 0 | 1 | 2 | 3 {
  if (step === "who") return 0;
  if (step === "what") return 1;
  if (step === "details") return 2;
  return 3;
}

export function PafFlow({ initial, team, whoSeesIt, isPreview, asWorkerId }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const [step, setStep] = useState<Step>(initial.step);
  const [person, setPerson] = useState<{ worker_id: string; display_name: string; account_key: string } | null>(
    initial.personWorkerId ? {
      worker_id: initial.personWorkerId,
      display_name: initial.personName ?? "",
      account_key: initial.personAccountKey ?? "",
    } : null,
  );
  const [action, setAction] = useState<PafAction | null>(initial.action);
  const [amount, setAmount] = useState(initial.amount);
  const [effectiveDate, setEffectiveDate] = useState(initial.effectiveDate);
  const [explanation, setExplanation] = useState(initial.explanation);
  const [missing, setMissing] = useState<Missing | null>(null);
  const [draftId, setDraftId] = useState<string | null>(initial.draftId);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // T4a (2026-11-13). In-page confirm for Discard draft: one click
  // flips to "confirm" so the viewer sees the consequence before the
  // row is deleted. No browser confirm().
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // Debounce ref for autosave.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipFirstSaveRef = useRef(true);

  // Keep the URL step/draft in sync when we advance.
  const pushParams = useCallback((patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === "") next.delete(k);
      else next.set(k, v);
    }
    const s = next.toString();
    router.push(s ? `${pathname}?${s}` : pathname);
  }, [sp, pathname, router]);

  const goTo = useCallback((s: Step) => {
    setStep(s);
    pushParams({ step: s });
  }, [pushParams]);

  const onPickPerson = useCallback((p: { worker_id: string; display_name: string; account_key: string }) => {
    setPerson(p);
    setStep("what");
    pushParams({ step: "what", for: p.worker_id });
  }, [pushParams]);

  const onChangePerson = useCallback(() => {
    setPerson(null);
    setAction(null);
    setAmount("");
    setEffectiveDate("");
    setExplanation("");
    setStep("who");
    pushParams({ step: "who", for: null });
  }, [pushParams]);

  const onChooseAction = useCallback((a: PafAction) => {
    setAction(a);
  }, []);

  // Save implementation. Builds the payload shape T4c will reuse
  // when writing `submissions` so recordDetail reads both without
  // branching.
  const buildPayload = useCallback(() => {
    return {
      _v: 2 as const,
      employeeName: person?.display_name ?? "",
      locationKey: person?.account_key ?? "",
      locationName: "", // T4c resolves this at send time
      person_worker_id: person?.worker_id ?? "",
      amount: amount || "",
      effectiveDate: effectiveDate || "",
      explanation: explanation || "",
    };
  }, [person, amount, effectiveDate, explanation]);

  const doSave = useCallback(async () => {
    if (isPreview) return;
    if (!action) return;
    setSaving("saving");
    const base = asWorkerId ? `/api/people/drafts?as=${encodeURIComponent(asWorkerId)}` : "/api/people/drafts";
    const body: Record<string, unknown> = {
      module: "paf",
      action_type: action,
      person_name: person?.display_name ?? null,
      payload: buildPayload(),
    };
    if (draftId) body.id = draftId;
    try {
      const res = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { draft: { id: string } };
      if (!draftId && data.draft?.id) {
        setDraftId(data.draft.id);
        // Patch URL to include the new id so a reload can rehydrate.
        const next = new URLSearchParams(sp.toString());
        next.set("draft", data.draft.id);
        router.replace(`${pathname}?${next.toString()}`);
      }
      setSaving("saved");
      setSavedAt(Date.now());
    } catch {
      setSaving("failed");
    }
  }, [isPreview, action, asWorkerId, draftId, person, buildPayload, sp, pathname, router]);

  // Debounced autosave. Fires on every Details change after the
  // first (skipFirstSaveRef avoids a save on the initial render
  // of the Details step when nothing has changed).
  useEffect(() => {
    if (step !== "details") return;
    if (isPreview) return;
    if (skipFirstSaveRef.current) { skipFirstSaveRef.current = false; return; }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { void doSave(); }, 600);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, effectiveDate, explanation, step]);

  const detailsComplete = useMemo(() => {
    return Number(amount) > 0 && !!effectiveDate && !!explanation.trim();
  }, [amount, effectiveDate, explanation]);

  const onCheckClick = useCallback(() => {
    // R-PP50: run the required-field check, show "Needed" on each
    // missing field + one summary at the top.
    const miss: Missing = {
      amount: !(Number(amount) > 0),
      effectiveDate: !effectiveDate,
      explanation: !explanation.trim(),
    };
    if (miss.amount || miss.effectiveDate || miss.explanation) {
      setMissing(miss);
      return;
    }
    setMissing(null);
    goTo("check");
  }, [amount, effectiveDate, explanation, goTo]);

  const onBack = useCallback(() => {
    if (step === "what") goTo("who");
    else if (step === "details") goTo("what");
    else if (step === "check") goTo("details");
  }, [step, goTo]);

  const onSaveAndExit = useCallback(async () => {
    if (isPreview) return;
    await doSave();
    router.push("/people?saved=1");
  }, [isPreview, doSave, router]);

  const onDiscard = useCallback(async () => {
    if (isPreview) return;
    if (!draftId) {
      // No draft yet - "discard" just means abandon what was typed.
      router.push("/people/inbox");
      return;
    }
    const base = asWorkerId
      ? `/api/people/drafts?id=${encodeURIComponent(draftId)}&as=${encodeURIComponent(asWorkerId)}`
      : `/api/people/drafts?id=${encodeURIComponent(draftId)}`;
    try {
      await fetch(base, { method: "DELETE" });
    } catch {
      // Swallow - the viewer is navigating away regardless.
    }
    router.push("/people/inbox");
  }, [isPreview, draftId, asWorkerId, router]);

  const savedText = useMemo(() => {
    if (saving === "saving") return "Saving...";
    if (saving === "failed") return "Could not save.";
    if (saving === "saved" && savedAt) return "Draft saved just now";
    return "";
  }, [saving, savedAt]);

  return (
    <div className="kf-pe-formwrap">
      <div className="kf-pe-sheet">
        <header className="kf-pe-sheet__head">
          <span className="kf-eyebrow kf-eyebrow--plain">
            {step === "who" ? "PAF · who" : step === "what" ? "PAF · what" : step === "details" ? "PAF · details" : "PAF · check"}
          </span>
          <h2>
            {step === "who" ? "Who is this for?" :
             step === "what" ? "What happened?" :
             step === "details" ? "Tell finance what and when" :
             "Last look"}
          </h2>
          <Stepper step={stepIndex(step)} />
          {savedText ? <span className="kf-pe-saved" role="status">{savedText}</span> : null}
        </header>

        <div className="kf-pe-sheet__body">
          {step === "who" ? (
            <WhoStep
              selfRow={team.selfRow}
              sites={team.sites}
              panels={team.panels}
              defaultSiteKey={team.defaultSiteKey}
              viewerWorkerId={team.viewerWorkerId}
              singleSiteView={team.singleSiteView}
              onPick={onPickPerson}
            />
          ) : null}

          {step === "what" ? (
            <WhatStep
              person={person ? { worker_id: person.worker_id, display_name: person.display_name } : null}
              chosen={action}
              onChoose={onChooseAction}
              onChange={onChangePerson}
            />
          ) : null}

          {step === "details" && action ? (
            <DetailsStep
              action={action}
              amount={amount}
              effectiveDate={effectiveDate}
              explanation={explanation}
              missing={missing}
              onChange={(patch) => {
                if (patch.amount !== undefined) setAmount(patch.amount);
                if (patch.effectiveDate !== undefined) setEffectiveDate(patch.effectiveDate);
                if (patch.explanation !== undefined) setExplanation(patch.explanation);
              }}
            />
          ) : null}

          {step === "check" && action ? (
            <CheckStep
              action={action}
              person={person ? { worker_id: person.worker_id, display_name: person.display_name } : null}
              amount={amount}
              effectiveDate={effectiveDate}
              explanation={explanation}
              whoSeesIt={whoSeesIt}
            />
          ) : null}
        </div>

        <footer className="kf-pe-sheet__foot">
          {step !== "who" ? (
            <button type="button" className="kf-btn kf-btn--ghost" onClick={onBack}>
              <ChevronLeft size={16} strokeWidth={1.5} aria-hidden />
              <span>Back</span>
            </button>
          ) : null}

          {step === "details" ? (
            <>
              <button
                type="button"
                className={`kf-btn kf-btn--line${isPreview ? " kf-pe-disabled" : ""}`}
                onClick={onSaveAndExit}
                aria-disabled={isPreview ? "true" : undefined}
                disabled={isPreview}
                title={isPreview ? "Preview mode does not save drafts." : undefined}
              >
                Save and exit
              </button>
              {/* T4a (2026-11-13). Discard draft: one click flips to
               * "Really discard?" so the viewer sees the consequence
               * before the row is deleted. No browser confirm(). */}
              {draftId ? (
                confirmDiscard ? (
                  <>
                    <span className="kf-pe-muted kf-pe-small">Really discard?</span>
                    <button
                      type="button"
                      className="kf-btn kf-btn--line"
                      onClick={() => setConfirmDiscard(false)}
                    >
                      Keep it
                    </button>
                    <button
                      type="button"
                      className="kf-btn kf-btn--ghost kf-pe-warn"
                      onClick={onDiscard}
                      disabled={isPreview}
                    >
                      Discard draft
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className={`kf-btn kf-btn--ghost${isPreview ? " kf-pe-disabled" : ""}`}
                    onClick={() => setConfirmDiscard(true)}
                    disabled={isPreview}
                    title={isPreview ? "Preview mode cannot discard drafts." : undefined}
                  >
                    Discard draft
                  </button>
                )
              ) : null}
            </>
          ) : null}

          <span className="kf-pe-foot__spacer" />

          {step === "what" ? (
            <button
              type="button"
              className="kf-btn kf-btn--primary"
              disabled={!action}
              aria-disabled={!action ? "true" : undefined}
              onClick={() => { goTo("details"); }}
            >
              <span>Next</span>
              <ArrowRight size={16} strokeWidth={1.5} aria-hidden />
            </button>
          ) : null}

          {step === "details" ? (
            <button
              type="button"
              className="kf-btn kf-btn--primary"
              onClick={onCheckClick}
            >
              <span>Check</span>
              <ArrowRight size={16} strokeWidth={1.5} aria-hidden />
            </button>
          ) : null}

          {step === "check" ? (
            <>
              <span className="kf-pe-foot__cap">Sending arrives in the next release.</span>
              <span
                className="kf-btn kf-btn--primary kf-pe-disabled"
                aria-disabled="true"
                title="Sending arrives with the forms train."
              >
                <span>Send to {whoSeesIt.route}</span>
              </span>
            </>
          ) : null}
        </footer>
      </div>

      {isPreview ? (
        <p className="kf-pe-muted kf-pe-small kf-pe-preview-note">
          Preview mode. The form works, but nothing saves and nothing sends.
        </p>
      ) : null}
    </div>
  );
}
