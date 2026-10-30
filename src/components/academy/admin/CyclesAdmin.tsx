"use client";

// Admin / Cycles. One client island hands over the whole page's
// interactivity so the RSC boundary stays clean (server page passes
// data props only; no handler / hook crosses). The island does:
//
//   - lists existing cycles with per-status actions
//   - opens the Create dialog (label + dates + audience_scope JSON
//     + module picker) and POSTs /api/academy/admin/cycles
//   - Preview via POST .../[cycleId]/preview and shows the plan
//     report in a dialog
//   - Publish via POST .../[cycleId]/publish - confirm step first,
//     disabled when the plan refuses
//   - Close via POST .../[cycleId]/close - confirm step first
//
// All of this is thin UI; the real work lives in the engine routes.

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Plus,
  Eye,
  Send,
  XCircle,
  CheckCircle2,
  Loader2,
} from "lucide-react";
import type { CycleRowWithCounts, ObligationPickRow } from "@/lib/academy/cycles";
import { fmtDate } from "@/lib/fmt";
import { AcademyBand, type AcademyBandFact } from "@/components/academy/AcademyBand";

type Props = {
  cycles: CycleRowWithCounts[];
  obligations: ObligationPickRow[];
};

type Dialog =
  | { kind: "none" }
  | { kind: "create" }
  | { kind: "preview"; cycle_id: string | number; plan: PlanReport | null; loading: boolean; error?: string }
  | { kind: "publish-confirm"; cycle_id: string | number; plan: PlanReport | null; loading: boolean; error?: string }
  | { kind: "close-confirm"; cycle_id: string | number; label: string; loading: boolean; error?: string };

interface PlanReport {
  modules?: number;
  peopleAffected?: number;
  totalRequirements?: number;
  byClass?: Record<string, number>;
  byAccount?: Record<string, number>;
  minutesSummary?: { min?: number; max?: number; avg?: number; total?: number };
  scopeRefusals?: string[];
  refuseReasons?: string[];
  wouldRefuseApply?: boolean;
  onHireModules?: string[];
  driftCandidates?: Array<{ worker_id: string; display_name?: string | null; reason?: string }>;
}

function statusPillClass(status: string): string {
  if (status === "draft") return "kf-pill kf-pill--draft";
  if (status === "published") return "kf-pill kf-pill--published";
  if (status === "closed") return "kf-pill kf-pill--closed";
  return "kf-pill kf-pill--muted";
}

function statusLabel(status: string): string {
  if (status === "draft") return "Draft";
  if (status === "published") return "Live";
  if (status === "closed") return "Closed";
  return status;
}

export function CyclesAdmin({ cycles, obligations }: Props) {
  const router = useRouter();
  const [dialog, setDialog] = useState<Dialog>({ kind: "none" });

  const openCreate = useCallback(() => setDialog({ kind: "create" }), []);

  const openPreview = useCallback(async (cycle_id: string | number) => {
    setDialog({ kind: "preview", cycle_id, plan: null, loading: true });
    try {
      const res = await fetch(`/api/academy/admin/cycles/${cycle_id}/preview`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDialog({
          kind: "preview",
          cycle_id,
          plan: null,
          loading: false,
          error: data.detail || data.error || `HTTP ${res.status}`,
        });
        return;
      }
      setDialog({
        kind: "preview",
        cycle_id,
        plan: data.plan?.report as PlanReport,
        loading: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setDialog({ kind: "preview", cycle_id, plan: null, loading: false, error: msg });
    }
  }, []);

  const openPublishConfirm = useCallback(async (cycle_id: string | number) => {
    // Fetch a fresh plan report so the confirm step names the real
    // numbers the next click will materialise.
    setDialog({ kind: "publish-confirm", cycle_id, plan: null, loading: true });
    try {
      const res = await fetch(`/api/academy/admin/cycles/${cycle_id}/preview`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDialog({
          kind: "publish-confirm",
          cycle_id,
          plan: null,
          loading: false,
          error: data.detail || data.error || `HTTP ${res.status}`,
        });
        return;
      }
      setDialog({
        kind: "publish-confirm",
        cycle_id,
        plan: data.plan?.report as PlanReport,
        loading: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setDialog({
        kind: "publish-confirm",
        cycle_id,
        plan: null,
        loading: false,
        error: msg,
      });
    }
  }, []);

  const doPublish = useCallback(async (cycle_id: string | number) => {
    setDialog((d) =>
      d.kind === "publish-confirm" && d.cycle_id === cycle_id
        ? { ...d, loading: true, error: undefined }
        : d,
    );
    try {
      const res = await fetch(`/api/academy/admin/cycles/${cycle_id}/publish`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDialog((d) =>
          d.kind === "publish-confirm" && d.cycle_id === cycle_id
            ? {
                ...d,
                loading: false,
                error:
                  data.detail ||
                  (data.reasons ? data.reasons.join("; ") : null) ||
                  data.error ||
                  `HTTP ${res.status}`,
              }
            : d,
        );
        return;
      }
      setDialog({ kind: "none" });
      router.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setDialog((d) =>
        d.kind === "publish-confirm" && d.cycle_id === cycle_id
          ? { ...d, loading: false, error: msg }
          : d,
      );
    }
  }, [router]);

  const openCloseConfirm = useCallback((cycle_id: string | number, label: string) => {
    setDialog({ kind: "close-confirm", cycle_id, label, loading: false });
  }, []);

  const doClose = useCallback(async (cycle_id: string | number) => {
    setDialog((d) =>
      d.kind === "close-confirm" && d.cycle_id === cycle_id
        ? { ...d, loading: true, error: undefined }
        : d,
    );
    try {
      const res = await fetch(`/api/academy/admin/cycles/${cycle_id}/close`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDialog((d) =>
          d.kind === "close-confirm" && d.cycle_id === cycle_id
            ? { ...d, loading: false, error: data.detail || data.error || `HTTP ${res.status}` }
            : d,
        );
        return;
      }
      setDialog({ kind: "none" });
      router.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setDialog((d) =>
        d.kind === "close-confirm" && d.cycle_id === cycle_id
          ? { ...d, loading: false, error: msg }
          : d,
      );
    }
  }, [router]);

  // Band facts, computed from the loaded cycles only. A "draft" leads
  // the band ("<label> is a draft"); if there is no draft, the band
  // says so honestly against the most recent cycle. No Questions
  // fact: that data (E2) is not loaded on this page.
  const draft = useMemo(
    () => cycles.find((c) => c.status === "draft") ?? null,
    [cycles],
  );
  const newest = cycles[0] ?? null;
  // statusLabel maps "published" -> "Live". Use the raw status for
  // the band's "no draft yet" sentence so it reads as "<label> is
  // published - no draft yet" instead of "is live", which is a UI
  // chip label not an English state.
  const rawStatus = newest
    ? newest.status === "published" ? "published"
      : newest.status === "closed" ? "closed"
      : newest.status
    : "";
  const bandTitle = draft
    ? `${draft.label} is a draft`
    : newest
      ? `${newest.label} is ${rawStatus} - no draft yet`
      : "No cycles yet";
  const bandKick = draft
    ? `Preview, then publish when the plan is clean.`
    : newest
      ? "Start a new cycle to assign the next window."
      : "Click New cycle to assign a training window.";
  const bandFacts: AcademyBandFact[] = [
    { label: "Cycles", value: cycles.length },
    { label: "Draft", value: draft ? "Yes" : "None" },
    { label: "Documents", value: draft ? draft.moduleCount : 0 },
  ];
  const docWord = (n: number) => `${n} document${n === 1 ? "" : "s"}`;
  const phoneStatus = draft
    ? `${draft.label} is a draft - ${docWord(draft.moduleCount)}`
    : newest
      ? `${newest.label} is ${rawStatus} - no draft yet`
      : "No cycles yet";

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
            onClick={openCreate}
            aria-label="New cycle"
          >
            <Plus size={14} strokeWidth={1.5} />
            <span>New cycle</span>
          </button>
        }
      />
      <p className="kf-pstatus" aria-label="Status">{phoneStatus}</p>
      <p className="kf-admin__sub kf-admin__sub--standalone">
        Create a cycle, preview who it assigns, then publish. Publishing writes
        requirements through the engine.
      </p>

      <section className="kf-cycles" aria-label="Cycles">
        {cycles.length === 0 ? (
          <div className="kf-cycle">
            <span className="kf-cycle__text">
              <span className="kf-cycle__label">No cycles yet</span>
              <span className="kf-cycle__window">Click New cycle to assign a training window.</span>
            </span>
          </div>
        ) : (
          cycles.map((c) => (
            <article key={String(c.cycle_id)} className="kf-cycle" aria-label={c.label}>
              <span className="kf-cycle__text">
                <span className="kf-cycle__label">{c.label}</span>
                <span className="kf-cycle__window">
                  {c.period_start ? fmtDate(c.period_start, "short") : "-"}
                  {" to "}
                  {c.period_end ? fmtDate(c.period_end, "short") : "-"}
                </span>
              </span>
              <span className={statusPillClass(c.status)}>{statusLabel(c.status)}</span>
              <span className="kf-cycle__count">
                <span>{c.moduleCount}</span>
                <span className="k">modules</span>
              </span>
              <span className="kf-cycle__count">
                <span>{c.issuedCount}</span>
                <span className="k">issued</span>
              </span>
              <span className="kf-cycle__actions">
                <button
                  type="button"
                  className="kf-cycle__btn"
                  onClick={() => openPreview(c.cycle_id)}
                  aria-label={`Preview ${c.label}`}
                >
                  <Eye size={14} strokeWidth={1.5} />
                  <span>Preview</span>
                </button>
                {c.status === "draft" ? (
                  <button
                    type="button"
                    className="kf-cycle__btn kf-cycle__btn--primary"
                    onClick={() => openPublishConfirm(c.cycle_id)}
                    aria-label={`Publish ${c.label}`}
                  >
                    <Send size={14} strokeWidth={1.5} />
                    <span>Publish</span>
                  </button>
                ) : null}
                {c.status === "published" ? (
                  <button
                    type="button"
                    className="kf-cycle__btn kf-cycle__btn--danger"
                    onClick={() => openCloseConfirm(c.cycle_id, c.label)}
                    aria-label={`Close ${c.label}`}
                  >
                    <XCircle size={14} strokeWidth={1.5} />
                    <span>Close</span>
                  </button>
                ) : null}
              </span>
            </article>
          ))
        )}
      </section>

      {dialog.kind === "create" ? (
        <CreateDialog
          obligations={obligations}
          onClose={() => setDialog({ kind: "none" })}
          onCreated={() => {
            setDialog({ kind: "none" });
            router.refresh();
          }}
        />
      ) : null}

      {dialog.kind === "preview" ? (
        <PreviewDialog
          cycle={cycles.find((c) => c.cycle_id === dialog.cycle_id) ?? null}
          plan={dialog.plan}
          loading={dialog.loading}
          error={dialog.error}
          onClose={() => setDialog({ kind: "none" })}
        />
      ) : null}

      {dialog.kind === "publish-confirm" ? (
        <PublishConfirmDialog
          cycle={cycles.find((c) => c.cycle_id === dialog.cycle_id) ?? null}
          plan={dialog.plan}
          loading={dialog.loading}
          error={dialog.error}
          onClose={() => setDialog({ kind: "none" })}
          onConfirm={() => doPublish(dialog.cycle_id)}
        />
      ) : null}

      {dialog.kind === "close-confirm" ? (
        <CloseConfirmDialog
          label={dialog.label}
          loading={dialog.loading}
          error={dialog.error}
          onClose={() => setDialog({ kind: "none" })}
          onConfirm={() => doClose(dialog.cycle_id)}
        />
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------
// Create dialog
// ------------------------------------------------------------------

function CreateDialog({
  obligations,
  onClose,
  onCreated,
}: {
  obligations: ObligationPickRow[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [label, setLabel] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [scopeText, setScopeText] = useState("{}");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const togglePick = useCallback((key: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const sortedPicked = useMemo(() => {
    // Preserve the catalog order so the stored sort_order ties out
    // to how the picker displayed them.
    return obligations
      .filter((o) => picked.has(`${o.doc_id}|${o.obligation_key}`))
      .map((o, i) => ({ ...o, _sort: (i + 1) * 10 }));
  }, [obligations, picked]);

  const submit = useCallback(async () => {
    setErrors([]);
    const localErrors: string[] = [];
    if (!label.trim()) localErrors.push("Label is required.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart)) localErrors.push("Period start must be YYYY-MM-DD.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) localErrors.push("Period end must be YYYY-MM-DD.");
    if (periodStart && periodEnd && periodEnd < periodStart) {
      localErrors.push("Period end must be on or after period start.");
    }
    if (sortedPicked.length === 0) localErrors.push("Pick at least one module.");
    let audience_scope: unknown = null;
    try {
      const trimmed = scopeText.trim();
      if (trimmed.length === 0 || trimmed === "null") audience_scope = null;
      else audience_scope = JSON.parse(trimmed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "invalid JSON";
      localErrors.push(`audience_scope JSON: ${msg}`);
    }
    if (localErrors.length > 0) {
      setErrors(localErrors);
      return;
    }

    setSubmitting(true);
    const body = {
      label: label.trim(),
      period_start: periodStart,
      period_end: periodEnd,
      audience_scope,
      modules: sortedPicked.map((m) => ({
        doc_id: m.doc_id,
        obligation_key: m.obligation_key,
        doc_version: m.doc_version,
        est_minutes: m.est_minutes,
        sort_order: m._sort,
      })),
    };
    try {
      const res = await fetch("/api/academy/admin/cycles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (Array.isArray(data.details)) {
          setErrors(data.details);
        } else {
          setErrors([data.detail || data.error || `HTTP ${res.status}`]);
        }
        setSubmitting(false);
        return;
      }
      setSubmitting(false);
      onCreated();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrors([msg]);
      setSubmitting(false);
    }
  }, [label, periodStart, periodEnd, scopeText, sortedPicked, onCreated]);

  return (
    <div className="kf-dialog-wrap" role="dialog" aria-modal="true" aria-label="Create cycle">
      <div className="kf-dialog">
        <div className="kf-dialog__head">
          <h3 className="kf-dialog__title">New cycle</h3>
          <button type="button" className="kf-dialog__close" onClick={onClose}>
            Cancel
          </button>
        </div>
        <div className="kf-dialog__body">
          <div className="kf-field">
            <label className="kf-field__label" htmlFor="cyc-label">Label</label>
            <input
              id="cyc-label"
              className="kf-input"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="November 2026"
            />
          </div>
          <div className="kf-field__row">
            <div className="kf-field">
              <label className="kf-field__label" htmlFor="cyc-start">Period start</label>
              <input
                id="cyc-start"
                className="kf-input"
                type="date"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
              />
            </div>
            <div className="kf-field">
              <label className="kf-field__label" htmlFor="cyc-end">Period end</label>
              <input
                id="cyc-end"
                className="kf-input"
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
              />
            </div>
          </div>
          <div className="kf-field">
            <label className="kf-field__label" htmlFor="cyc-scope">Audience scope (JSON)</label>
            <textarea
              id="cyc-scope"
              className="kf-textarea"
              value={scopeText}
              onChange={(e) => setScopeText(e.target.value)}
              spellCheck={false}
            />
            <span className="kf-field__hint">
              Empty <code>{"{}"}</code> or <code>null</code> = every eligible person. Shape:{" "}
              <code>{"{"} worker_class?: &quot;all&quot;|&quot;salaried&quot;|&quot;hourly&quot;, accounts?: string[], regions?: string[], worker_ids?: string[] {"}"}</code>.
            </span>
          </div>
          <div className="kf-field">
            <span className="kf-field__label">Modules</span>
            <span className="kf-field__hint">
              Pick what every assigned person will read + sign. {picked.size} selected.
            </span>
            <div className="kf-mod-picker" role="group" aria-label="Modules">
              {obligations.map((o) => {
                const key = `${o.doc_id}|${o.obligation_key}`;
                const checked = picked.has(key);
                return (
                  <label key={key} className="kf-mod-row">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => togglePick(key)}
                      aria-label={`${o.doc_id} ${o.obligation_key}`}
                    />
                    <span className="kf-mod-row__text">
                      <span className="kf-mod-row__title">
                        {o.doc_id} - {o.obligation_key}
                      </span>
                      {o.description ? (
                        <span className="kf-mod-row__sub">{o.description}</span>
                      ) : null}
                    </span>
                    <span className="kf-mod-row__meta">
                      v{o.doc_version ?? "-"} - {o.est_minutes ?? "-"} min
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
          {errors.length > 0 ? (
            <div className="kf-form-errors" role="alert">
              <strong>Could not save:</strong>
              <ul>
                {errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        <div className="kf-dialog__foot">
          <button type="button" className="kf-dialog__close" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className={`kf-cycle__btn kf-cycle__btn--primary${submitting ? " is-busy" : ""}`}
            onClick={submit}
            disabled={submitting}
          >
            {submitting ? <Loader2 size={14} strokeWidth={1.5} /> : <Plus size={14} strokeWidth={1.5} />}
            <span>{submitting ? "Creating..." : "Create draft"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Preview dialog (plan report, read-only)
// ------------------------------------------------------------------

function PreviewDialog({
  cycle,
  plan,
  loading,
  error,
  onClose,
}: {
  cycle: CycleRowWithCounts | null;
  plan: PlanReport | null;
  loading: boolean;
  error: string | undefined;
  onClose: () => void;
}) {
  return (
    <div className="kf-dialog-wrap" role="dialog" aria-modal="true" aria-label="Preview cycle">
      <div className="kf-dialog">
        <div className="kf-dialog__head">
          <h3 className="kf-dialog__title">
            Preview - {cycle?.label ?? "cycle"}
          </h3>
          <button type="button" className="kf-dialog__close" onClick={onClose}>Close</button>
        </div>
        <div className="kf-dialog__body">
          {loading ? (
            <p className="kf-admin__sub">Running the plan - this is read-only; nothing is written.</p>
          ) : error ? (
            <div className="kf-form-errors" role="alert">{error}</div>
          ) : plan ? (
            <>
              <div className="kf-plan">
                <div className="kf-plan__row">
                  <span>Modules in this cycle</span>
                  <span>{plan.modules ?? 0}</span>
                </div>
                <div className="kf-plan__row">
                  <span>People that would be assigned</span>
                  <span>{plan.peopleAffected ?? 0}</span>
                </div>
                <div className="kf-plan__row">
                  <span>Requirement rows that would be written</span>
                  <span>{plan.totalRequirements ?? 0}</span>
                </div>
                {plan.minutesSummary ? (
                  <div className="kf-plan__row">
                    <span>Minutes per person (avg / total)</span>
                    <span>
                      {plan.minutesSummary.avg ?? 0} / {plan.minutesSummary.total ?? 0}
                    </span>
                  </div>
                ) : null}
              </div>
              {plan.wouldRefuseApply ? (
                <div className="kf-plan__refuse">
                  Publish would be refused:
                  <ul>
                    {(plan.refuseReasons ?? []).map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {(plan.scopeRefusals ?? []).length > 0 ? (
                <div className="kf-plan__refuse">
                  Scope errors:
                  <ul>
                    {(plan.scopeRefusals ?? []).map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Publish confirm dialog
// ------------------------------------------------------------------

function PublishConfirmDialog({
  cycle,
  plan,
  loading,
  error,
  onClose,
  onConfirm,
}: {
  cycle: CycleRowWithCounts | null;
  plan: PlanReport | null;
  loading: boolean;
  error: string | undefined;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const refused = !!plan?.wouldRefuseApply;
  const total = plan?.totalRequirements ?? 0;
  const people = plan?.peopleAffected ?? 0;
  const canPublish = !!plan && !refused && !loading;
  return (
    <div className="kf-dialog-wrap" role="dialog" aria-modal="true" aria-label="Confirm publish">
      <div className="kf-dialog">
        <div className="kf-dialog__head">
          <h3 className="kf-dialog__title">Publish {cycle?.label ?? "cycle"}</h3>
          <button type="button" className="kf-dialog__close" onClick={onClose}>Cancel</button>
        </div>
        <div className="kf-dialog__body">
          {!plan && !error ? (
            <p className="kf-admin__sub">Reading the live plan...</p>
          ) : error ? (
            <div className="kf-form-errors" role="alert">{error}</div>
          ) : plan ? (
            <>
              <p>
                Publishing will issue{" "}
                <strong>{total}</strong> requirement{total === 1 ? "" : "s"} to{" "}
                <strong>{people}</strong> person{people === 1 ? "" : "s"}. Each row is a permanent
                compliance record - there is no bulk delete.
              </p>
              {refused ? (
                <div className="kf-plan__refuse">
                  Publish is refused by the plan:
                  <ul>
                    {(plan.refuseReasons ?? []).map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                  Fix the cycle (or its scope) and preview again before publishing.
                </div>
              ) : null}
            </>
          ) : null}
        </div>
        <div className="kf-dialog__foot">
          <button type="button" className="kf-dialog__close" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className={`kf-cycle__btn kf-cycle__btn--primary${loading ? " is-busy" : ""}`}
            onClick={onConfirm}
            disabled={!canPublish}
          >
            {loading ? <Loader2 size={14} strokeWidth={1.5} /> : <Send size={14} strokeWidth={1.5} />}
            <span>{loading ? "Publishing..." : `Publish ${total} requirement${total === 1 ? "" : "s"}`}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Close confirm dialog
// ------------------------------------------------------------------

function CloseConfirmDialog({
  label,
  loading,
  error,
  onClose,
  onConfirm,
}: {
  label: string;
  loading: boolean;
  error: string | undefined;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="kf-dialog-wrap" role="dialog" aria-modal="true" aria-label="Confirm close">
      <div className="kf-dialog">
        <div className="kf-dialog__head">
          <h3 className="kf-dialog__title">Close {label}</h3>
          <button type="button" className="kf-dialog__close" onClick={onClose}>Cancel</button>
        </div>
        <div className="kf-dialog__body">
          <p>
            Closing retires this cycle&apos;s window. Issued requirements are not touched -
            they stay on each person&apos;s Done ledger. A closed cycle cannot be re-opened.
          </p>
          {error ? <div className="kf-form-errors" role="alert">{error}</div> : null}
        </div>
        <div className="kf-dialog__foot">
          <button type="button" className="kf-dialog__close" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className={`kf-cycle__btn kf-cycle__btn--danger${loading ? " is-busy" : ""}`}
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? <Loader2 size={14} strokeWidth={1.5} /> : <CheckCircle2 size={14} strokeWidth={1.5} />}
            <span>{loading ? "Closing..." : "Close cycle"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
