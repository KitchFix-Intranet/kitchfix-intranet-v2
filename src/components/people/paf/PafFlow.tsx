"use client";

// T4b-1 (2026-11-14). PAF flow. Four steps (Who · What · Details ·
// Check). State model now carries the full SheetFields object so
// every action in this + T4a's sheet set can autosave + check.
//
// Route params produced by this component:
//   ?step=who|what|details|check
//   ?for=<worker_id>   (set when the user picks a person)
//   ?draft=<uuid>      (set after the first autosave create)
//
// Autosave: on every Details change, debounced 600ms. First save
// creates the row; subsequent saves PATCH it. Under ?as= nothing
// autosaves and Save-and-exit is disabled with a caption.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { ChevronLeft, ArrowRight, Send } from "lucide-react";
import { ACTION_LABEL } from "@/lib/people/labels";
import { Stepper } from "./Stepper";
import { WhoStep } from "./WhoStep";
import { WhatStep, type PafAction } from "./WhatStep";
import { DetailsStep } from "./DetailsStep";
import { CheckStep, type WhoSeesItView } from "./CheckStep";
import type { SelfRosterPerson, SiteNavEntry, SitePanel } from "@/lib/people/types";
import type { SelectOption } from "./Select";
import type { SheetFields } from "./sheetFields";
import { EMPTY_FIELDS, missingFor } from "./sheetFields";

type Step = "who" | "what" | "details" | "check";

interface EnrichedPerson {
  worker_id: string;
  display_name: string;
  account_key: string;
  title: string | null;
  site_name: string | null;
}

type Props = {
  initial: {
    step: Step;
    draftId: string | null;
    person: EnrichedPerson | null;
    action: PafAction | null;
    fields: SheetFields;
  };
  team: {
    selfRow: SelfRosterPerson | null;
    sites: SiteNavEntry[];
    panels: Record<string, SitePanel>;
    defaultSiteKey: string;
    viewerWorkerId: string;
    singleSiteView: boolean;
  };
  whoSeesIt: WhoSeesItView;
  accountOptions: readonly SelectOption[];
  isPreview: boolean;
  asWorkerId: string | null;
};

function stepIndex(step: Step): 0 | 1 | 2 | 3 {
  if (step === "who") return 0;
  if (step === "what") return 1;
  if (step === "details") return 2;
  return 3;
}

// Pick which fields to keep on the draft payload for a given
// action. Fields that are irrelevant for the action never reach
// the server (the API whitelist is the ultimate gate, but we
// filter client-side so the draft payload stays small + readable).
function fieldsForDraft(action: PafAction | null, f: SheetFields): Record<string, string> {
  const out: Record<string, string> = {};
  const emit = (k: keyof SheetFields) => {
    const v = f[k];
    if (v) out[k] = String(v);
  };
  if (!action) return out;
  emit("effectiveDate");
  if (action === "add_bonus" || action === "add_deduction" || action === "add_gratuity") {
    emit("amount"); emit("explanation");
  } else if (action === "add_cell_phone") {
    emit("amount"); emit("cellFrequency");
  } else if (action === "separation") {
    emit("lastDayWorked"); emit("actionGroup"); emit("separationReason"); emit("rehireEligible"); emit("explanation");
  } else if (action === "title_change") {
    emit("newTitle"); emit("reclassChangeRate");
    if (f.reclassChangeRate === "Yes") emit("newRate");
    emit("explanation");
  } else if (action === "status_change") {
    emit("statusChangeDirection"); emit("explanation");
  } else if (action === "reclassification") {
    emit("reclassFrom"); emit("reclassTo"); emit("reclassTitleChange");
    if (f.reclassTitleChange === "Yes") emit("newTitle");
    emit("reclassChangeRate");
    if (f.reclassChangeRate === "Yes") emit("newRate");
    emit("explanation");
  }
  return out;
}

export function PafFlow({ initial, team, whoSeesIt, accountOptions, isPreview, asWorkerId }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const [step, setStep] = useState<Step>(initial.step);
  const [person, setPerson] = useState<EnrichedPerson | null>(initial.person);
  const [action, setAction] = useState<PafAction | null>(initial.action);
  const [fields, setFields] = useState<SheetFields>(initial.fields);
  const [missing, setMissing] = useState<ReturnType<typeof missingFor> | null>(null);
  const [draftId, setDraftId] = useState<string | null>(initial.draftId);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipFirstSaveRef = useRef(true);

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
    // When a person is picked on Who we only have the roster-level
    // fields. The title + site_name second line gets filled by the
    // server on the next page render (the ?for=<worker_id> round
    // trip). For the transient state here, leave them null; the
    // SheetAbout falls back to a single line.
    setPerson({
      worker_id: p.worker_id,
      display_name: p.display_name,
      account_key: p.account_key,
      title: null,
      site_name: null,
    });
    setStep("what");
    pushParams({ step: "what", for: p.worker_id });
  }, [pushParams]);

  const onChangePerson = useCallback(() => {
    setPerson(null);
    setAction(null);
    setFields(EMPTY_FIELDS);
    setMissing(null);
    setStep("who");
    pushParams({ step: "who", for: null });
  }, [pushParams]);

  const onChooseAction = useCallback((a: PafAction) => { setAction(a); }, []);

  const onChangeFields = useCallback((patch: Partial<SheetFields>) => {
    setFields((cur) => ({ ...cur, ...patch }));
  }, []);

  const buildPayload = useCallback(() => {
    return {
      _v: 2 as const,
      employeeName: person?.display_name ?? "",
      locationKey: person?.account_key ?? "",
      locationName: person?.site_name ?? "",
      person_worker_id: person?.worker_id ?? "",
      ...fieldsForDraft(action, fields),
    };
  }, [person, action, fields]);

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
      const data = (await res.json()) as { draft: { id: string; payload?: Record<string, unknown> } };
      if (!draftId && data.draft?.id) {
        setDraftId(data.draft.id);
        const next = new URLSearchParams(sp.toString());
        next.set("draft", data.draft.id);
        router.replace(`${pathname}?${next.toString()}`);
      }
      // Pull server-authoritative oldTitle back onto the fields so
      // Check shows the current role immediately after save.
      const srvOld = String(data.draft?.payload?.oldTitle ?? "");
      if (srvOld && srvOld !== fields.oldTitle) {
        setFields((cur) => ({ ...cur, oldTitle: srvOld }));
      }
      setSaving("saved");
      setSavedAt(Date.now());
    } catch {
      setSaving("failed");
    }
  }, [isPreview, action, asWorkerId, draftId, person, buildPayload, sp, pathname, router, fields.oldTitle]);

  // Debounced autosave on any Details change.
  useEffect(() => {
    if (step !== "details") return;
    if (isPreview) return;
    if (skipFirstSaveRef.current) { skipFirstSaveRef.current = false; return; }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { void doSave(); }, 600);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, step]);

  const onCheckClick = useCallback(() => {
    const miss = missingFor(action, fields);
    if (Object.values(miss).some(Boolean)) { setMissing(miss); return; }
    setMissing(null);
    goTo("check");
  }, [action, fields, goTo]);

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
    if (!draftId) { router.push("/people/inbox"); return; }
    const base = asWorkerId
      ? `/api/people/drafts?id=${encodeURIComponent(draftId)}&as=${encodeURIComponent(asWorkerId)}`
      : `/api/people/drafts?id=${encodeURIComponent(draftId)}`;
    try { await fetch(base, { method: "DELETE" }); } catch { /* swallow */ }
    router.push("/people/inbox");
  }, [isPreview, draftId, asWorkerId, router]);

  const savedText = useMemo(() => {
    if (saving === "saving") return "Saving...";
    if (saving === "failed") return "Could not save.";
    if (saving === "saved" && savedAt) return "Draft saved just now";
    return "";
  }, [saving, savedAt]);

  const eyebrow = (step === "details" || step === "check") && action
    ? `PAF · ${ACTION_LABEL[action] ?? action}`
    : "PAF";

  // Titles per action on Details + Check. Each action's Details
  // sheet has its own h2 in the render; T4a used "How much, and
  // why?" for all three money sheets. T4b-1 adds the five new
  // sheet titles.
  function detailsTitle(a: PafAction | null): string {
    if (a === "separation") return "When, and why?";
    if (a === "title_change") return "What is the new role?";
    if (a === "status_change") return "Which way?";
    if (a === "reclassification") return "Where are they moving?";
    if (a === "add_cell_phone") return "How much, and how often?";
    return "How much, and why?";
  }
  const title =
    step === "who" ? "Who is this about?" :
    step === "what" ? "What needs to happen?" :
    step === "details" ? detailsTitle(action) :
    "Ready to send?";

  // Side-column note per step. Who: static sentence describing the
  // routing (derivable from the four groups in WhatStep); What +
  // Details: empty in T4b-1 (reserved for "Already pending"); Check:
  // no side note (the body carries "Who sees it").
  function sideContent() {
    if (isPreview) {
      return (
        <div className="kf-pe-note">
          <b>Preview mode</b> The form works, but nothing saves and nothing sends.
        </div>
      );
    }
    if (step === "who") {
      return (
        <div className="kf-pe-note">
          <b>Who sees it</b> Depends on the action. HR actions and equipment go to HR; payroll and expenses go to finance.
        </div>
      );
    }
    return null;
  }

  // Send-button copy keyed off the action's route (title_change +
  // reclassification + separation + status_change -> HR; everything
  // else -> finance). Button stays disabled in T4b-1.
  const sendRoute = action === "separation"
    || action === "title_change"
    || action === "status_change"
    || action === "reclassification"
    ? "HR"
    : whoSeesIt.route;

  return (
    <div className="kf-pe-formwrap">
      <div className="kf-pe-sheet">
        <header className="kf-pe-sheet__head">
          <span className="kf-eyebrow">{eyebrow}</span>
          <h2>{title}</h2>
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
              person={person ? { display_name: person.display_name, title: person.title, site_name: person.site_name } : null}
              chosen={action}
              onChoose={onChooseAction}
              onChange={onChangePerson}
            />
          ) : null}

          {step === "details" && action ? (
            <DetailsStep
              action={action}
              person={person ? { display_name: person.display_name, title: person.title, site_name: person.site_name } : null}
              fields={fields}
              missing={missing ?? {}}
              onChange={onChangeFields}
              accountOptions={accountOptions}
            />
          ) : null}

          {step === "check" && action ? (
            <CheckStep
              action={action}
              person={person ? { display_name: person.display_name, title: person.title, site_name: person.site_name } : null}
              fields={fields}
              whoSeesIt={whoSeesIt}
              accountOptions={accountOptions}
            />
          ) : null}
        </div>

        <footer className="kf-pe-sheet__foot">
          {step !== "who" ? (
            <button type="button" className="kf-btn kf-btn--ghost kf-pe-foot__back" onClick={onBack}>
              <ChevronLeft size={16} strokeWidth={1.5} aria-hidden />
              <span>Back</span>
            </button>
          ) : null}

          <span className="kf-pe-foot__spacer" />

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
              {draftId ? (
                confirmDiscard ? (
                  <>
                    <span className="kf-pe-muted kf-pe-small">Really discard?</span>
                    <button type="button" className="kf-btn kf-btn--line" onClick={() => setConfirmDiscard(false)}>Keep it</button>
                    <button type="button" className="kf-btn kf-btn--ghost kf-pe-warn" onClick={onDiscard} disabled={isPreview}>Discard draft</button>
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
            <button type="button" className="kf-btn kf-btn--primary" onClick={onCheckClick}>
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
                <Send size={16} strokeWidth={1.5} aria-hidden />
                <span>Send to {sendRoute}</span>
              </span>
            </>
          ) : null}
        </footer>
      </div>

      <aside className="kf-pe-side" aria-label="Side notes">
        {sideContent()}
      </aside>
    </div>
  );
}
