"use client";

// Capture file drop zone. On drop/pick, for each file in order:
//   1. mint a draft id (browser uuid)
//   2. POST /api/invoices/drafts { id, site }
//   3. POST /api/invoices/uploads { draft_id, file_name, size_bytes }
//   4. PUT file bytes to the signed URL
//   5. POST /api/invoices/files { draft_id, file_id, file_name }
// On first success, route to that draft's sitting.
//
// This client never talks to the storage path - only to the three
// server routes. Correction 5.

import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { FileUp } from "lucide-react";

type RowStatus = "queued" | "making_draft" | "signing" | "uploading" | "finishing" | "done" | "failed";

interface Row {
  key: string;
  file_name: string;
  size_bytes: number;
  status: RowStatus;
  error: string | null;
  draft_id: string | null;
}

function uuid(): string {
  // crypto.randomUUID is in both Node and modern browsers.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // Fallback for very old runtimes: not expected in production.
  const r = () => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `${r()}${r()}-${r()}-${r()}-${r()}-${r()}${r()}${r()}`;
}

const ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp";
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
  const inputRef = useRef<HTMLInputElement | null>(null);

  const asQ = asParam ? `?as=${encodeURIComponent(asParam)}` : "";

  const upsertRow = useCallback((key: string, patch: Partial<Row>) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }, []);

  const processFile = useCallback(async (f: File) => {
    const key = uuid();
    const row: Row = { key, file_name: f.name, size_bytes: f.size, status: "queued", error: null, draft_id: null };
    setRows((prev) => [...prev, row]);

    if (f.size > MAX_BYTES) {
      upsertRow(key, { status: "failed", error: "File is bigger than 50 MB." });
      return;
    }

    const draftId = uuid();
    upsertRow(key, { status: "making_draft", draft_id: draftId });

    // 1. Create the draft.
    const r1 = await fetch(`/api/invoices/drafts${asQ}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: draftId, site: siteSlug, screen }),
    });
    if (!r1.ok) {
      upsertRow(key, { status: "failed", error: "Could not start the draft." });
      return;
    }

    // 2. Ask for an upload slot.
    upsertRow(key, { status: "signing" });
    const r2 = await fetch(`/api/invoices/uploads${asQ}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        draft_id: draftId,
        file_name: f.name,
        size_bytes: f.size,
        mime_type_hint: f.type,
      }),
    });
    if (!r2.ok) {
      const body = await r2.json().catch(() => ({ error: "" }));
      const msg = body.error === "unsupported_type"
        ? (f.name.toLowerCase().endsWith(".heic") || f.name.toLowerCase().endsWith(".heif")
            ? "Save it as a PDF or a JPEG and add it again."
            : "That file kind is not accepted.")
        : body.error === "too_large" ? "File is bigger than 50 MB."
        : "Could not sign the upload.";
      upsertRow(key, { status: "failed", error: msg });
      return;
    }
    const slot = (await r2.json()) as { file_id: string; signed_url: string; signed_path: string };

    // 3. PUT the bytes direct to storage. Browser -> Supabase bucket.
    upsertRow(key, { status: "uploading" });
    const putRes = await fetch(slot.signed_url, {
      method: "PUT",
      body: f,
      headers: { "content-type": f.type || "application/octet-stream" },
    });
    if (!putRes.ok) {
      upsertRow(key, { status: "failed", error: "Upload was cut off. Try again." });
      return;
    }

    // 4. Finish on the server (magic bytes, sha, pages, row insert).
    upsertRow(key, { status: "finishing" });
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
          ? "That file is not a PDF or a picture."
          : "Could not read the file.";
      upsertRow(key, { status: "failed", error: msg });
      return;
    }
    upsertRow(key, { status: "done" });

    // Route to the first finished draft's sitting.
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

  return (
    <div>
      <div
        className={`kf-inv-capture__dropzone${hover ? " is-hover" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setHover(true); }}
        onDragLeave={() => setHover(false)}
        onDrop={onDrop}
      >
        <FileUp size={32} strokeWidth={1.5} aria-hidden />
        <h3>Add invoices</h3>
        <p>Drop a PDF or a picture here, or choose a file.</p>
        <button type="button" className="kf-btn kf-btn--primary" onClick={() => inputRef.current?.click()}>
          Choose files
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          className="kf-inv-capture__dropzone-input"
          onChange={(e) => onFiles(e.currentTarget.files)}
        />
      </div>
      {rows.length > 0 ? (
        <ul className="kf-inv-uploads" role="status" aria-live="polite">
          {rows.map((r) => (
            <li key={r.key} className={`kf-inv-uploads__row${r.status === "failed" ? " is-failed" : r.status === "done" ? " is-done" : ""}`}>
              <span>{r.file_name}</span>
              <span>
                {r.status === "queued" && "Waiting"}
                {r.status === "making_draft" && "Starting the draft"}
                {r.status === "signing" && "Preparing"}
                {r.status === "uploading" && "Uploading"}
                {r.status === "finishing" && "Checking the file"}
                {r.status === "done" && "Added"}
                {r.status === "failed" && (r.error ?? "Failed")}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
