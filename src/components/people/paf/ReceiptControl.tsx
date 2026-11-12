"use client";

// T4b-2 + T4b-2.1 (2026-11-12). Receipt attachment control for
// Travel + Other reimbursement. Thin client that drives the
// /api/people/attachments route. One POST per file, with the
// browser-claimed MIME alongside the bytes - the server does its
// own magic-byte check and rejects anything that does not match.
// 10 MB per file; 5 attachments per draft.
//
// The route signs the preview URL with a 60s TTL. We never cache
// the signed URL; clicking preview re-asks the server.
//
// On "Remove" the server deletes the row AND the storage object in
// one call. Half-deletes stay invisible to the viewer.
//
// T4b-2.1 UX fixes:
//   - Wrapper is a <div>, not a <label>. (A <label> wrap was
//     catching clicks on the hint text + size text and opening the
//     file picker.)
//   - Error strings are plain words (not the raw server code).
//   - A failed remove shows "Could not remove <name>." - no silence.

import { useCallback, useEffect, useRef, useState } from "react";
import { Paperclip, X } from "lucide-react";

export interface AttachmentRow {
  id: string;
  file_name: string;
  file_size: number;
  mime_type: string;
}

function fmtSize(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 5;

// Server error codes → plain words for the viewer.
function uploadErrorText(code: string, name: string): string {
  switch (code) {
    case "too_large":         return `${name} is larger than 10 MB.`;
    case "unsupported_type":  return `${name} is not a PDF or image we can read.`;
    case "too_many_files":    return `This draft already has ${MAX_FILES} receipts.`;
    case "preview_no_write":  return `Preview mode cannot attach receipts.`;
    case "action_not_receipts": return `This action does not take receipts.`;
    case "draft_not_found":   return `The draft is no longer available.`;
    default:                  return `Could not attach ${name}. Try again.`;
  }
}

export function ReceiptControl({
  draftId, asWorkerId, label, hint, isPreview, initialRows,
}: {
  draftId: string | null;
  asWorkerId: string | null;
  label: string;
  hint: string;
  isPreview: boolean;
  // When set, skip the initial server fetch and use these rows
  // instead. Used by the screenshot harness to show the attached
  // state without needing the API.
  initialRows?: AttachmentRow[];
}) {
  const [rows, setRows] = useState<AttachmentRow[]>(initialRows ?? []);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const skipFetch = useRef<boolean>(!!initialRows);

  const qp = useCallback((extra: Record<string, string> = {}) => {
    const q = new URLSearchParams();
    if (draftId) q.set("draft", draftId);
    if (asWorkerId) q.set("as", asWorkerId);
    for (const [k, v] of Object.entries(extra)) q.set(k, v);
    return q.toString();
  }, [draftId, asWorkerId]);

  // Initial load.
  useEffect(() => {
    if (!draftId) { setRows([]); return; }
    if (skipFetch.current) { skipFetch.current = false; return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/people/attachments?${qp()}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { rows: AttachmentRow[] };
        if (!cancelled) setRows(data.rows ?? []);
      } catch { /* leave as-is */ }
    })();
    return () => { cancelled = true; };
  }, [draftId, qp]);

  const atCap = rows.length >= MAX_FILES;
  const disabled = busy || isPreview || !draftId || atCap;

  const onPick = () => {
    if (!inputRef.current) return;
    inputRef.current.value = "";
    inputRef.current.click();
  };

  const onFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    if (!draftId) {
      setErr("Save the draft first (type anything and the system will save) before attaching a receipt.");
      return;
    }
    if (isPreview) {
      setErr("Preview mode cannot attach receipts.");
      return;
    }
    setErr(null);
    setBusy(true);
    for (const file of Array.from(files)) {
      if (rows.length >= MAX_FILES) {
        setErr(`This draft already has ${MAX_FILES} receipts.`);
        break;
      }
      if (file.size > MAX_BYTES) {
        setErr(`${file.name} is larger than 10 MB.`);
        continue;
      }
      try {
        const form = new FormData();
        form.append("file", file, file.name);
        const res = await fetch(`/api/people/attachments?${qp()}`, {
          method: "POST",
          body: form,
        });
        if (!res.ok) {
          let code = "";
          try { const d = await res.json(); code = (d as { error?: string }).error ?? ""; } catch { /* no body */ }
          setErr(uploadErrorText(code, file.name));
          continue;
        }
        const data = (await res.json()) as { row: AttachmentRow };
        setRows((cur) => [...cur, data.row]);
      } catch {
        setErr(uploadErrorText("", file.name));
      }
    }
    setBusy(false);
  }, [draftId, isPreview, rows.length, qp]);

  const onRemove = useCallback(async (row: AttachmentRow) => {
    if (isPreview) return;
    try {
      const res = await fetch(`/api/people/attachments?${qp({ id: row.id })}`, { method: "DELETE" });
      if (res.ok || res.status === 204) {
        setRows((cur) => cur.filter((r) => r.id !== row.id));
        setErr(null);
      } else {
        setErr(`Could not remove ${row.file_name}.`);
      }
    } catch {
      setErr(`Could not remove ${row.file_name}.`);
    }
  }, [isPreview, qp]);

  const onPreview = useCallback(async (row: AttachmentRow) => {
    if (isPreview) return;
    try {
      const res = await fetch(`/api/people/attachments?${qp({ id: row.id, view: "1" })}`, { cache: "no-store" });
      if (!res.ok) { setErr(`Could not open ${row.file_name}.`); return; }
      const data = (await res.json()) as { url?: string };
      if (data.url) window.open(data.url, "_blank", "noopener,noreferrer");
      setErr(null);
    } catch { setErr(`Could not open ${row.file_name}.`); }
  }, [isPreview, qp]);

  const buttonText = atCap
    ? `${MAX_FILES} receipts attached`
    : rows.length > 0 ? "Add another" : label;

  return (
    <div className="kf-pe-field" role="group" aria-labelledby="paf-rcpt-lbl">
      <span id="paf-rcpt-lbl">{label}</span>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/heic,application/pdf"
        multiple
        hidden
        onChange={(e) => void onFiles(e.currentTarget.files)}
      />
      <button
        type="button"
        className="kf-btn kf-btn--line"
        onClick={onPick}
        disabled={disabled}
        aria-disabled={disabled ? "true" : undefined}
        aria-describedby="paf-rcpt-hint"
      >
        <Paperclip size={18} strokeWidth={1.5} aria-hidden />
        <span>{buttonText}</span>
      </button>
      <small id="paf-rcpt-hint" className="kf-pe-field__hint2">
        {hint} Up to {MAX_FILES} receipts per request.
      </small>
      {err ? <small className="kf-pe-recdrop__err" role="alert">{err}</small> : null}
      {rows.length > 0 ? (
        <ul className="kf-pe-recdrop" aria-label="Attached receipts">
          {rows.map((row) => (
            <li key={row.id} className="kf-pe-recdrop__row">
              <button
                type="button"
                className="kf-pe-recdrop__name kf-btn kf-btn--ghost"
                onClick={() => void onPreview(row)}
                title="Open receipt"
              >
                {row.file_name}
              </button>
              <span className="kf-pe-recdrop__size">{fmtSize(row.file_size)}</span>
              <button
                type="button"
                className="kf-pe-recdrop__rm"
                onClick={() => void onRemove(row)}
                aria-label={`Remove ${row.file_name}`}
                title="Remove"
                disabled={isPreview}
              >
                <X size={16} strokeWidth={1.5} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
