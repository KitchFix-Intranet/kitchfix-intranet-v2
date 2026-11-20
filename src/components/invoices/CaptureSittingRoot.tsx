"use client";

// The sitting: one invoice at a time, page beside the fields on
// desk, stacked on phone.
//
// Save loop (correction 7, 8): one in-flight PATCH at a time; the
// If-Match header carries the exact updated_at string the DB
// returned. New field changes merge into a staged patch until the
// current save returns.
//
// Local persistence (correction 7): a per-draft "dirty" flag in
// localStorage + a merged-patch body. On mount, if dirty: flush to
// server; otherwise server wins. Flag cleared on successful save.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { fmtDate } from "@/lib/fmt";
import { fmtUsdExact } from "@/lib/invoices/money";
import type { CheckResult, DraftView, FileView, GlLineDraft, InvoiceKind } from "@/lib/invoices/types";
import { addsUp, leftToCode } from "@/lib/invoices/addUp";
import { parseDateInput } from "@/lib/invoices/dateInput";
import { parseMoneyInput } from "@/lib/invoices/moneyInput";
import type { SiteGlCode } from "@/lib/invoices/glCodes";
import type { UsualCode } from "@/lib/invoices/usualCodes";
import { VendorPicker } from "./VendorPicker";
import { OwnerPreviewBanner } from "./OwnerPreviewBanner";

const PdfPage = dynamic(() => import("./PdfPage").then((m) => m.PdfPage), { ssr: false });

type Staged = Partial<{
  vendor_id: string | null;
  type: InvoiceKind;
  invoice_number: string | null;
  invoice_date: string | null;
  total_amount: number | null;
  gl_breakdown: GlLineDraft[];
  answers: DraftView["answers"];
}>;

const SAVE_DEBOUNCE_MS = 700;

function ls(): Storage | null {
  try { return typeof window !== "undefined" ? window.localStorage : null; } catch { return null; }
}

function lsKey(draftId: string): string { return `kf.invoices.draft.${draftId}`; }

export function CaptureSittingRoot({
  initialDraft,
  initialFiles,
  initialVendorName,
  initialViewUrlByFileId,
  activeCodes,
  initialUsual,
  siteSlug,
  siteAccountKey,
  asParam,
  previewName,
  isPreview,
}: {
  initialDraft: DraftView;
  initialFiles: FileView[];
  initialVendorName: string | null;
  initialViewUrlByFileId: Record<string, string>;
  activeCodes: SiteGlCode[];
  initialUsual: { codes: UsualCode[]; singleCodeFill: UsualCode | null; sampleSize: number };
  siteSlug: string;
  siteAccountKey: string;
  asParam: string | null;
  previewName: string | null;
  isPreview: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<DraftView>(initialDraft);
  const [files, setFiles] = useState<FileView[]>(initialFiles);
  const [vendorName, setVendorName] = useState<string | null>(initialVendorName);
  const [viewUrls, setViewUrls] = useState<Record<string, string>>(initialViewUrlByFileId);
  const [usual, setUsual] = useState(initialUsual);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [errors, setErrors] = useState<CheckResult["errors"]>([]);
  const [readyToast, setReadyToast] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "error" | "offline">("idle");
  const [copyBanner, setCopyBanner] = useState<string | null>(null);

  // Save queue state - refs so the loop doesn't restart on every render.
  const stagedRef = useRef<Staged>({});
  const inflightRef = useRef<boolean>(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = useRef<DraftView>(draft);
  useEffect(() => { draftRef.current = draft; }, [draft]);

  const asQ = asParam ? `?as=${encodeURIComponent(asParam)}` : "";
  const draftId = initialDraft.id;

  // On mount: if a dirty local copy exists for this draft, flush it.
  useEffect(() => {
    const store = ls();
    if (!store) return;
    const raw = store.getItem(lsKey(draftId));
    if (!raw) return;
    try {
      const saved = JSON.parse(raw) as { dirty: boolean; patch: Staged };
      if (saved.dirty && saved.patch) {
        stagedRef.current = { ...stagedRef.current, ...saved.patch };
        scheduleFlush();
      }
    } catch { /* ignore */ }

  }, []);

  const writeLocal = useCallback((dirty: boolean) => {
    const store = ls();
    if (!store) return;
    try {
      if (dirty) {
        store.setItem(lsKey(draftId), JSON.stringify({ dirty: true, patch: stagedRef.current }));
      } else {
        store.removeItem(lsKey(draftId));
      }
    } catch { /* ignore */ }
  }, [draftId]);

  const scheduleFlush = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { void flush(); }, SAVE_DEBOUNCE_MS);
  }, []);

  const flush = useCallback(async () => {
    if (inflightRef.current) return;
    const body = stagedRef.current;
    if (!body || Object.keys(body).length === 0) return;
    if (isPreview) {
      setSaveState("error");
      return;
    }
    inflightRef.current = true;
    setSaveState("saving");
    stagedRef.current = {};
    try {
      const res = await fetch(`/api/invoices/drafts/${draftId}${asQ}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "if-match": draftRef.current.updated_at,
        },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const out = (await res.json()) as { draft: DraftView };
        setDraft(out.draft);
        setSaveState("idle");
        writeLocal(false);
      } else if (res.status === 409) {
        // Another tab saved. Reload the page so we start from the
        // newer state; the local "dirty" flag is cleared on the
        // other side of the reload only if the server wins.
        setSaveState("error");
        setCopyBanner("The draft was changed in another tab. Reloading...");
        setTimeout(() => router.refresh(), 500);
      } else {
        setSaveState("error");
      }
    } catch {
      setSaveState("offline");
      // Merge back the body we tried so it gets retried.
      stagedRef.current = { ...body, ...stagedRef.current };
      writeLocal(true);
    } finally {
      inflightRef.current = false;
      // If new edits piled up during the request, run again.
      if (Object.keys(stagedRef.current).length > 0) scheduleFlush();
    }
  }, [asQ, draftId, isPreview, router, scheduleFlush, writeLocal]);

  const stage = useCallback(<K extends keyof Staged>(key: K, value: Staged[K]) => {
    stagedRef.current = { ...stagedRef.current, [key]: value };
    writeLocal(true);
    scheduleFlush();
  }, [scheduleFlush, writeLocal]);

  // Online/offline banner.
  useEffect(() => {
    const on = () => { if (saveState === "offline") void flush(); };
    const off = () => setSaveState("offline");
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, [flush, saveState]);

  // Field handlers.
  const [invNumLocal, setInvNumLocal] = useState<string>(draft.invoice_number ?? "");
  const [invDateLocal, setInvDateLocal] = useState<string>(draft.invoice_date ?? "");
  const [totalLocal, setTotalLocal] = useState<string>(draft.total_amount != null ? String(draft.total_amount) : "");

  const invDateParsed = useMemo(() => parseDateInput(invDateLocal), [invDateLocal]);
  const totalParsed = useMemo(() => parseMoneyInput(totalLocal), [totalLocal]);

  const onInvNumChange = (v: string) => {
    const capped = v.slice(0, 50);
    setInvNumLocal(capped);
    stage("invoice_number", capped || null);
  };

  const onInvDateChange = (v: string) => {
    setInvDateLocal(v);
    const parsed = parseDateInput(v);
    stage("invoice_date", parsed.iso);
  };

  const onTotalChange = (v: string) => {
    setTotalLocal(v);
    const parsed = parseMoneyInput(v);
    stage("total_amount", parsed);

    // Single-code fill (§6 "the fill rule").
    if (parsed != null && usual.singleCodeFill && (draft.gl_breakdown ?? []).length === 0) {
      const code = usual.singleCodeFill;
      const nextGl: GlLineDraft[] = [{ code: code.code, name: code.name, amount: parsed }];
      stage("gl_breakdown", nextGl);
      setDraft((d) => ({ ...d, gl_breakdown: nextGl }));
    }
  };

  const onKindFlip = () => {
    const next: InvoiceKind = draft.type === "invoice" ? "credit" : "invoice";
    stage("type", next);
    setDraft((d) => ({ ...d, type: next }));
  };

  const onVendorPicked = async (v: { id: string; name: string }) => {
    setVendorName(v.name);
    setPickerOpen(false);
    stage("vendor_id", v.id);
    setDraft((d) => ({ ...d, vendor_id: v.id }));
    // Refetch usual codes for the new vendor (fire and forget).
    try {
      const res = await fetch(`/api/invoices/gl-codes?site=${encodeURIComponent(siteSlug)}&vendor_id=${encodeURIComponent(v.id)}${asQ ? `&${asQ.slice(1)}` : ""}`);
      if (res.ok) {
        const body = await res.json() as { usual: typeof usual };
        if (body.usual) setUsual(body.usual);
      }
    } catch { /* ignore */ }
  };

  // Coding helpers.
  const gl = draft.gl_breakdown ?? [];
  const totalNum = draft.total_amount ?? null;

  const updateGl = (next: GlLineDraft[]) => {
    stage("gl_breakdown", next);
    setDraft((d) => ({ ...d, gl_breakdown: next }));
  };

  const putAllToCode = (code: UsualCode) => {
    if (totalNum == null) return;
    updateGl([{ code: code.code, name: code.name, amount: totalNum }]);
  };
  const addSplitLine = (code: UsualCode) => {
    const left = totalNum != null ? leftToCode(totalNum, gl) : 0;
    const amount = left > 0 ? Math.round(left * 100) / 100 : 0;
    updateGl([...gl, { code: code.code, name: code.name, amount }]);
  };
  const updateLine = (idx: number, patch: Partial<GlLineDraft>) => {
    const next = gl.map((l, i) => (i === idx ? { ...l, ...patch } : l));
    updateGl(next);
  };
  const removeLine = (idx: number) => {
    const next = gl.filter((_, i) => i !== idx);
    updateGl(next);
  };

  // Files.
  const [activeFileId, setActiveFileId] = useState<string | null>(initialFiles[0]?.id ?? null);
  const activeFile = useMemo(() => files.find((f) => f.id === activeFileId) ?? null, [files, activeFileId]);

  const rotateActive = async () => {
    if (!activeFile || isPreview) return;
    const next = ((activeFile.rotation + 90) % 360) as 0 | 90 | 180 | 270;
    const res = await fetch(`/api/invoices/files/${activeFile.id}${asQ ? asQ + "&" : "?"}draft=${draftId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rotation: next }),
    });
    if (res.ok) {
      const out = (await res.json()) as { file: FileView };
      setFiles((fs) => fs.map((f) => (f.id === out.file.id ? out.file : f)));
    }
  };
  const removeActive = async () => {
    if (!activeFile || isPreview) return;
    await fetch(`/api/invoices/files/${activeFile.id}/remove${asQ ? asQ + "&" : "?"}draft=${draftId}`, { method: "POST" });
    setFiles((fs) => fs.filter((f) => f.id !== activeFile.id));
    setActiveFileId((prev) => {
      if (prev !== activeFile.id) return prev;
      const next = files.filter((f) => f.id !== activeFile.id)[0];
      return next?.id ?? null;
    });
  };

  // Check and send.
  const [checking, setChecking] = useState(false);
  const check = async () => {
    setChecking(true);
    try {
      // Flush any pending save first so the server sees the latest.
      if (Object.keys(stagedRef.current).length > 0) await flush();
      const res = await fetch(`/api/invoices/drafts/${draftId}/check${asQ}`, { method: "POST" });
      if (!res.ok) { setErrors([{ field: "files", message: "Could not run the check." }]); return; }
      const result = (await res.json()) as CheckResult;
      setErrors(result.errors);
      if (result.ready) {
        setReadyToast("Ready. Sending is switched on in the next update.");
        setTimeout(() => setReadyToast(null), 4000);
      }
    } finally {
      setChecking(false);
    }
  };

  const canSave = !isPreview;
  const leftNow = totalNum != null ? leftToCode(totalNum, gl) : null;
  const addedUp = addsUp(totalNum, gl);

  const invDateErr = errors.find((e) => e.field === "invoice_date" || e.field === "date_more_than_60") ?? null;
  const invNumErr = errors.find((e) => e.field === "invoice_number") ?? null;
  const totalErr = errors.find((e) => e.field === "total_amount") ?? null;
  const vendorErr = errors.find((e) => e.field === "vendor_id") ?? null;
  const codingErr = errors.find((e) => e.field === "gl_breakdown") ?? null;
  const copyErr = errors.find((e) => e.field === "copy") ?? null;
  const fileErr = errors.find((e) => e.field === "files") ?? null;
  const dateConfirmErr = errors.find((e) => e.field === "date_more_than_60") ?? null;

  return (
    <div className="kf-invoices-surface kf-inv-sitting-wrap">
      {previewName ? <OwnerPreviewBanner name={previewName} exitHref="/invoices" /> : null}
      <div className="kf-inv-sitting__nav">
        <span className="kf-inv-sitting__which">{vendorName ?? "Pick a vendor"} <span className="kf-inv-sitting__site">· {siteAccountKey}</span></span>
        <div style={{ display: "flex", gap: "var(--sp-sp-2)" }}>
          <a href={`/invoices?site=${siteSlug}${asQ ? `&${asQ.slice(1)}` : ""}`} className="kf-btn kf-btn--sm kf-btn--line">Back</a>
          {!isPreview ? (
            <button
              type="button"
              className="kf-btn kf-btn--sm kf-btn--ghost"
              onClick={async () => {
                if (!confirm("Discard this draft?")) return;
                const res = await fetch(`/api/invoices/drafts/${draftId}/discard${asQ}`, { method: "POST" });
                if (res.ok) router.push(`/invoices?site=${siteSlug}${asQ ? `&${asQ.slice(1)}` : ""}`);
              }}
            >
              Discard
            </button>
          ) : null}
        </div>
      </div>

      {saveState === "offline" ? <p className="kf-inv-sitting__hint">No signal. Your typing is kept on this device.</p> : null}
      {saveState === "error" && copyBanner ? <p className="kf-inv-sitting__err">{copyBanner}</p> : null}

      <div className="kf-inv-sitting">
        <section className="kf-inv-sitting__page">
          <div className="kf-inv-sitting__page-tools">
            {files.length > 1 ? (
              <select
                value={activeFileId ?? ""}
                onChange={(e) => setActiveFileId(e.currentTarget.value)}
                aria-label="Pick a page"
              >
                {files.map((f, i) => (
                  <option key={f.id} value={f.id}>Page {i + 1}: {f.file_name}</option>
                ))}
              </select>
            ) : null}
            {activeFile && canSave ? (
              <>
                <button type="button" className="kf-btn kf-btn--sm kf-btn--line" onClick={rotateActive}>Rotate</button>
                <button type="button" className="kf-btn kf-btn--sm kf-btn--line" onClick={removeActive}>Remove the file</button>
              </>
            ) : null}
          </div>
          <div className="kf-inv-sitting__canvas">
            {activeFile == null ? (
              <p className="kf-inv-sitting__no-file">No file yet.</p>
            ) : activeFile.mime_type === "application/pdf" ? (
              viewUrls[activeFile.id] ? (
                <PdfPage url={viewUrls[activeFile.id]} rotation={activeFile.rotation} />
              ) : (
                <p className="kf-inv-sitting__hint">Preparing the page...</p>
              )
            ) : (
              viewUrls[activeFile.id] ? (
                <img src={viewUrls[activeFile.id]} alt="Invoice page" style={{ transform: `rotate(${activeFile.rotation}deg)` }} />
              ) : (
                <p className="kf-inv-sitting__hint">Preparing the page...</p>
              )
            )}
          </div>
        </section>

        <section className="kf-inv-sitting__form">
          {/* Vendor */}
          <div className="kf-inv-sitting__field">
            <label>Vendor</label>
            <button
              type="button"
              data-vendor
              aria-invalid={vendorErr ? true : false}
              aria-describedby={vendorErr ? "err-vendor" : undefined}
              onClick={() => setPickerOpen(true)}
              disabled={isPreview}
            >
              {vendorName ?? "Pick a vendor"}
            </button>
            {vendorErr ? <span id="err-vendor" className="kf-inv-sitting__err">{vendorErr.message}</span> : null}
          </div>

          {/* Kind toggle */}
          <p className="kf-inv-sitting__kind">
            {draft.type === "invoice" ? "This is an invoice. " : "This is a credit. "}
            <button type="button" onClick={onKindFlip} disabled={isPreview}>
              {draft.type === "invoice" ? "It is a credit" : "It is an invoice"}
            </button>
          </p>

          {/* Invoice number */}
          <div className="kf-inv-sitting__field">
            <label htmlFor="inv-num">Invoice number</label>
            <input
              id="inv-num"
              value={invNumLocal}
              onChange={(e) => onInvNumChange(e.currentTarget.value)}
              aria-invalid={invNumErr ? true : false}
              aria-describedby={invNumErr ? "err-num" : undefined}
              maxLength={50}
              disabled={isPreview}
            />
            {invNumErr ? <span id="err-num" className="kf-inv-sitting__err">{invNumErr.message}</span> : null}
          </div>

          {/* Invoice date */}
          <div className="kf-inv-sitting__field">
            <label htmlFor="inv-date">Invoice date</label>
            <input
              id="inv-date"
              value={invDateLocal}
              onChange={(e) => onInvDateChange(e.currentTarget.value)}
              placeholder="MM/DD/YYYY"
              aria-invalid={invDateErr ? true : false}
              aria-describedby={invDateErr ? "err-date" : undefined}
              disabled={isPreview}
            />
            {invDateParsed.iso && invDateParsed.future ? (
              <span id="err-date-future" className="kf-inv-sitting__err">The date is in the future.</span>
            ) : null}
            {invDateParsed.iso && invDateParsed.moreThan60DaysBack && !draft.answers.date_confirmed_at_more_than_60_days ? (
              <div className="kf-inv-sitting__err">
                This date is more than 60 days back. Is that right?
                <button
                  type="button"
                  className="kf-btn kf-btn--sm kf-btn--line"
                  style={{ marginLeft: "var(--sp-sp-2)" }}
                  onClick={() => {
                    const ans = { ...draft.answers, date_confirmed_at_more_than_60_days: true as const };
                    stage("answers", ans);
                    setDraft((d) => ({ ...d, answers: ans }));
                  }}
                >
                  Yes, it is
                </button>
              </div>
            ) : null}
            {invDateErr && !dateConfirmErr ? <span id="err-date" className="kf-inv-sitting__err">{invDateErr.message}</span> : null}
          </div>

          {/* Total */}
          <div className="kf-inv-sitting__field">
            <label htmlFor="inv-total">Total</label>
            <input
              id="inv-total"
              value={totalLocal}
              onChange={(e) => onTotalChange(e.currentTarget.value)}
              placeholder="$0.00"
              aria-invalid={totalErr ? true : false}
              aria-describedby={totalErr ? "err-total" : undefined}
              disabled={isPreview}
            />
            {totalParsed != null ? <span className="kf-inv-sitting__hint">{fmtUsdExact(totalParsed)}</span> : null}
            {totalErr ? <span id="err-total" className="kf-inv-sitting__err">{totalErr.message}</span> : null}
          </div>

          {/* Coding */}
          <div className="kf-inv-sitting__coding">
            <label>Coding</label>
            {usual.codes.length > 0 ? (
              <div className="kf-inv-sitting__coding-chips">
                {usual.codes.slice(0, 6).map((c) => (
                  <button
                    key={c.code}
                    type="button"
                    className="kf-inv-sitting__coding-chip"
                    onClick={() => {
                      // "All of it to" when the chip equals singleCodeFill's code
                      if (usual.singleCodeFill?.code === c.code && totalNum != null) {
                        putAllToCode(c);
                      } else {
                        addSplitLine(c);
                      }
                    }}
                    disabled={isPreview}
                  >
                    {c.code} · {c.name}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="kf-inv-sitting__coding-rows">
              {gl.map((line, i) => (
                <div key={i} className="kf-inv-sitting__coding-row">
                  <select
                    value={line.code}
                    onChange={(e) => {
                      const code = e.currentTarget.value;
                      const match = activeCodes.find((c) => c.code === code);
                      updateLine(i, { code, name: match?.name ?? line.name });
                    }}
                    disabled={isPreview}
                  >
                    {activeCodes.map((c) => (
                      <option key={c.code} value={c.code}>{c.code} · {c.name}</option>
                    ))}
                  </select>
                  <input
                    inputMode="decimal"
                    value={String(line.amount)}
                    onChange={(e) => {
                      const amt = parseMoneyInput(e.currentTarget.value);
                      if (amt != null) updateLine(i, { amount: amt });
                    }}
                    disabled={isPreview}
                  />
                  <button type="button" onClick={() => removeLine(i)} disabled={isPreview}>Remove</button>
                </div>
              ))}
            </div>
            <p className={`kf-inv-sitting__left-to-code${leftNow === 0 ? " is-done" : (leftNow ?? 0) < 0 ? " is-over" : ""}`}>
              {leftNow == null ? "Type the total first." : leftNow === 0 ? "Adds up" : `${fmtUsdExact(leftNow)} left to code`}
            </p>
            {codingErr ? <span className="kf-inv-sitting__err">{codingErr.message}</span> : null}
          </div>

          {/* Files */}
          <div className="kf-inv-sitting__coding">
            <label>Files</label>
            <ul className="kf-inv-sitting__files">
              {files.map((f) => (
                <li
                  key={f.id}
                  className={`kf-inv-sitting__file${f.id === activeFileId ? " is-active" : ""}`}
                >
                  <button type="button" className="kf-btn kf-btn--ghost kf-btn--sm" onClick={() => setActiveFileId(f.id)}>
                    {f.file_name}
                  </button>
                  <span>{f.page_count != null ? `${f.page_count} ${f.page_count === 1 ? "page" : "pages"}` : "?"}</span>
                </li>
              ))}
            </ul>
            {fileErr ? <span className="kf-inv-sitting__err">{fileErr.message}</span> : null}
          </div>

          {/* Copy banner */}
          {copyErr ? <p className="kf-inv-sitting__err">{copyErr.message}</p> : null}

          {/* Actions */}
          <div className="kf-inv-sitting__actions">
            <button
              type="button"
              className="kf-btn kf-btn--primary"
              onClick={check}
              disabled={checking || isPreview}
            >
              {checking ? "Checking..." : "Check and send"}
            </button>
            <span className="kf-inv-sitting__hint">
              {saveState === "saving" ? "Saving..." : saveState === "offline" ? "No signal" : "Saved"}
              {addedUp && totalNum != null ? " · Adds up" : ""}
            </span>
          </div>
          <p className="kf-inv-sitting__hint">Lines are read after it is sent.</p>
        </section>
      </div>

      {pickerOpen ? (
        <VendorPicker
          siteSlug={siteSlug}
          asParam={asParam}
          onPick={(v) => void onVendorPicked(v)}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}

      {readyToast ? (
        <div className="kf-invoices-preview" role="status" style={{ position: "fixed", bottom: 24, right: 24, zIndex: 100 }}>
          <span className="kf-invoices-preview__name">{readyToast}</span>
        </div>
      ) : null}
    </div>
  );
}
