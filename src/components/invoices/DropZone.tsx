"use client";

// Capture file drop zone + upload tray + same-file-twice dialog.
//
// For each dropped file:
//   1. mint a draft id (browser uuid)
//   2. POST /api/invoices/drafts        -> create the draft
//   3. POST /api/invoices/uploads       -> get a signed PUT url
//   4. PUT file bytes to the bucket
//   5. POST /api/invoices/files         -> finish; magic bytes,
//      sha-256, page count, row insert; may return dupe_of
// On the first FINISH success the browser routes to that draft's
// sitting. A failed file never leaves a draft that looks fine (the
// row is only created after step 1 and the sitting is only opened
// after step 5). Train 2b correction 12: a failed row offers a
// "Try again" button that re-runs the whole file.

import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { FileUp } from "lucide-react";
import { Sheet } from "./Sheet";

type RowStatus = "uploading" | "checking" | "added" | "failed";

interface Row {
  key: string;
  file_name: string;
  source: File;                         // for Try again
  status: RowStatus;
  message: string | null;               // shown with the status
  draft_id: string | null;
  // Set when the finish route detected the same sha on another
  // live draft of this viewer's. The B9 dialog uses it.
  dupe_of: { draft_id: string; file_id: string } | null;
  file_id: string | null;
}

function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const r = () => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `${r()}${r()}-${r()}-${r()}-${r()}-${r()}${r()}${r()}`;
}

const ACCEPT_DESK = ".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp";
const ACCEPT_PHONE = ".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp";
const MAX_BYTES = 52_428_800;

export function DropZone({
  siteSlug,
  asParam,
  screen,
}: {
  siteSlug: string;
  asParam: string | null;
  screen: "desk" | "phone";
}) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [hover, setHover] = useState(false);
  const [dupeRow, setDupeRow] = useState<Row | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const asQ = asParam ? `?as=${encodeURIComponent(asParam)}` : "";
  const phone = screen === "phone";

  const upsertRow = useCallback((key: string, patch: Partial<Row>) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }, []);

  const processFile = useCallback(async (f: File, existingKey?: string) => {
    const key = existingKey ?? uuid();
    if (!existingKey) {
      const row: Row = {
        key, file_name: f.name, source: f, status: "uploading", message: null,
        draft_id: null, dupe_of: null, file_id: null,
      };
      setRows((prev) => [...prev, row]);
    } else {
      upsertRow(key, { status: "uploading", message: null });
    }

    if (f.size > MAX_BYTES) {
      upsertRow(key, { status: "failed", message: "Over 50 MB" });
      return;
    }

    const draftId = uuid();
    upsertRow(key, { draft_id: draftId });

    // 1. Create the draft.
    const r1 = await fetch(`/api/invoices/drafts${asQ}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: draftId, site: siteSlug, screen }),
    });
    if (!r1.ok) {
      upsertRow(key, { status: "failed", message: "Could not start the draft." });
      return;
    }

    // 2. Ask for an upload slot.
    const r2 = await fetch(`/api/invoices/uploads${asQ}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draft_id: draftId, file_name: f.name, size_bytes: f.size, mime_type_hint: f.type }),
    });
    if (!r2.ok) {
      const body = await r2.json().catch(() => ({ error: "" }));
      const nameLower = f.name.toLowerCase();
      const msg = body.error === "unsupported_type"
        ? (nameLower.endsWith(".heic") || nameLower.endsWith(".heif")
            ? "Save it as a PDF or a JPEG and add it again."
            : "Not a PDF or a picture.")
        : body.error === "too_large" ? "Over 50 MB"
        : "Could not prepare the upload.";
      upsertRow(key, { status: "failed", message: msg });
      return;
    }
    const slot = (await r2.json()) as { file_id: string; signed_url: string; signed_path: string };

    // 3. PUT the bytes direct to storage.
    const putRes = await fetch(slot.signed_url, {
      method: "PUT",
      body: f,
      headers: { "content-type": f.type || "application/octet-stream" },
    });
    if (!putRes.ok) {
      upsertRow(key, { status: "failed", message: "Upload was cut off." });
      return;
    }

    // 4. Finish on the server.
    upsertRow(key, { status: "checking", file_id: slot.file_id });
    const r4 = await fetch(`/api/invoices/files${asQ}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draft_id: draftId, file_id: slot.file_id, file_name: f.name }),
    });
    if (!r4.ok) {
      const body = await r4.json().catch(() => ({ error: "" }));
      const msg = body.error === "heic_not_supported"
        ? "Save it as a PDF or a JPEG and add it again."
        : body.error === "unsupported_type" || body.error === "kind_mismatch"
          ? "Not a PDF or a picture."
          : "Could not read the file.";
      upsertRow(key, { status: "failed", message: msg });
      return;
    }
    const finish = (await r4.json()) as { file: { id: string }; dupe_of: { draft_id: string; file_id: string } | null };
    upsertRow(key, { status: "added", message: null, dupe_of: finish.dupe_of });

    // Train 2b correction 12: B9 same-file-twice dialog. The row is
    // kept (the dialog offers to remove it); we open the sheet on
    // the first dupe detected.
    if (finish.dupe_of) {
      setRows((prev) => {
        const row = prev.find((r) => r.key === key) ?? null;
        if (row) setDupeRow(row);
        return prev;
      });
      // Do not route - let the user decide.
      return;
    }

    // Route to the finished draft's sitting.
    router.push(`/invoices?site=${encodeURIComponent(siteSlug)}&draft=${draftId}${asQ ? `&${asQ.slice(1)}` : ""}`);
  }, [asQ, router, siteSlug, screen, upsertRow]);

  const onFiles = useCallback((list: FileList | null) => {
    if (!list) return;
    for (const f of Array.from(list)) {
      void processFile(f);
    }
  }, [processFile]);

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setHover(false);
    onFiles(e.dataTransfer?.files ?? null);
  }, [onFiles]);

  const retry = useCallback((row: Row) => {
    void processFile(row.source, row.key);
  }, [processFile]);

  const removeAfterDupe = useCallback(async () => {
    if (!dupeRow || !dupeRow.draft_id || !dupeRow.file_id) return;
    await fetch(`/api/invoices/files/${dupeRow.file_id}/remove?draft=${dupeRow.draft_id}${asQ ? `&${asQ.slice(1)}` : ""}`, { method: "POST" });
    // The draft is empty now; discard it.
    await fetch(`/api/invoices/drafts/${dupeRow.draft_id}/discard${asQ}`, { method: "POST" });
    setRows((prev) => prev.filter((r) => r.key !== dupeRow.key));
    setDupeRow(null);
  }, [asQ, dupeRow]);

  const keepAfterDupe = useCallback(() => {
    if (!dupeRow || !dupeRow.draft_id) return;
    const draftId = dupeRow.draft_id;
    setDupeRow(null);
    router.push(`/invoices?site=${encodeURIComponent(siteSlug)}&draft=${draftId}${asQ ? `&${asQ.slice(1)}` : ""}`);
  }, [asQ, dupeRow, router, siteSlug]);

  return (
    <div className="kf-inv-dropzone-wrap">
      <div
        className={`kf-inv-capture__dropzone${hover ? " is-hover" : ""}`}
        onDragOver={phone ? undefined : (e) => { e.preventDefault(); setHover(true); }}
        onDragLeave={phone ? undefined : () => setHover(false)}
        onDrop={phone ? undefined : onDrop}
      >
        <FileUp size={32} strokeWidth={1.5} aria-hidden />
        <p>
          {phone
            ? "The vendor's emailed copy or a clean scan."
            : "Drop the vendor's copy or a clean scan here. Several at once is fine."}
        </p>
        <button type="button" className="kf-btn kf-btn--primary" onClick={() => inputRef.current?.click()}>
          {phone ? "Choose a file" : "Choose files"}
        </button>
        <p className="kf-inv-capture__dropzone-hint">PDF, JPG or PNG.</p>
        <input
          ref={inputRef}
          type="file"
          accept={phone ? ACCEPT_PHONE : ACCEPT_DESK}
          multiple={!phone}
          className="kf-inv-capture__dropzone-input"
          onChange={(e) => onFiles(e.currentTarget.files)}
        />
      </div>

      {rows.length > 0 ? (
        <ul className="kf-inv-uploads" role="status" aria-live="polite">
          {rows.map((r) => (
            <li
              key={r.key}
              className={`kf-inv-uploads__row${r.status === "failed" ? " is-failed" : r.status === "added" ? " is-done" : ""}`}
            >
              <span className="kf-inv-uploads__name">{r.file_name}</span>
              <span className="kf-inv-uploads__status">
                {r.status === "uploading" && "Uploading"}
                {r.status === "checking" && "Checking"}
                {r.status === "added" && "Added"}
                {r.status === "failed" && (r.message ?? "Failed")}
              </span>
              {r.status === "failed" ? (
                <button
                  type="button"
                  className="kf-btn kf-btn--sm kf-btn--line"
                  onClick={() => retry(r)}
                >
                  Try again
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {dupeRow ? (
        <Sheet
          title="You already added this file"
          onClose={() => setDupeRow(null)}
          footer={
            <>
              <button type="button" className="kf-btn kf-btn--ghost" onClick={removeAfterDupe}>
                Remove this one
              </button>
              <button
                type="button"
                className="kf-btn kf-btn--primary"
                data-autofocus
                onClick={keepAfterDupe}
              >
                Use it anyway
              </button>
            </>
          }
        >
          <p>
            A file with the same bytes is already on another of your drafts. If this is the same invoice, remove this one. If it is a different invoice that happens to be identical, keep it.
          </p>
        </Sheet>
      ) : null}
    </div>
  );
}
