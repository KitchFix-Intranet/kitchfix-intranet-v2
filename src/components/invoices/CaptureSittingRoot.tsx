"use client";

// The sitting: one invoice at a time. Desk: slim top row, page
// beside the fields. Phone paths (D1-D7) are the same component -
// CSS branches at 860 px. All of section 6's C1..C13 rules + the
// corrections (keyboard, shared toaster, no browser dialogs, no
// signed URLs in server HTML, retry-with-backoff) land here.
//
// Save loop (train 2a + correction 4.2): one in-flight PATCH per
// draft, If-Match on updated_at. On a 500 ("save_failed") the
// client retries with growing backoff (0.5, 1, 2, 4 s) then stops
// and shows "Not saved. Changes are kept on this device." On 409
// ("conflict") the page re-reads, preserving the staged patch.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Files,
  Image as ImageIcon,
  MoreHorizontal,
  Plus,
  RotateCw,
  Trash2,
  Upload,
  Calendar as CalIcon,
  Check,
  AlertTriangle,
} from "lucide-react";
import { toast } from "@/components/ui/Toaster";
import { fmtDate } from "@/lib/fmt";
import { fmtUsdExact } from "@/lib/invoices/money";
import type {
  CheckResult, CopyMatchView, DraftView, FileView, GlLineDraft, InvoiceKind,
} from "@/lib/invoices/types";
import { addsUp, leftToCode } from "@/lib/invoices/addUp";
import { parseDateInput, toBoxDate } from "@/lib/invoices/dateInput";
import { parseMoneyInput } from "@/lib/invoices/moneyInput";
import type { SiteGlCode } from "@/lib/invoices/glCodes";
import type { UsualCode } from "@/lib/invoices/usualCodes";
import { applySingleCodeFill } from "@/lib/invoices/usualCodes";
import { waitForCheckAction } from "@/lib/invoices/saveWait";
import { VendorPicker } from "./VendorPicker";
import { OwnerPreviewBanner } from "./OwnerPreviewBanner";
import { Sheet } from "./Sheet";
import { Menu } from "./Menu";
import { Calendar as InvCalendar } from "./Calendar";
import { useIsPhone } from "./useIsPhone";
import { useKeyboardOffset } from "./useKeyboardOffset";

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

interface Pager {
  position: number;
  total: number;
  prevDraftId: string | null;
  nextDraftId: string | null;
}

const SAVE_DEBOUNCE_MS = 700;
const SAVE_BACKOFF_MS = [500, 1000, 2000, 4000] as const;

function ls(): Storage | null {
  try { return typeof window !== "undefined" ? window.localStorage : null; } catch { return null; }
}
function lsKey(draftId: string): string { return `kf.invoices.draft.${draftId}`; }

export function CaptureSittingRoot({
  initialDraft,
  initialFiles,
  initialVendorName,
  activeCodes,
  initialUsual,
  siteSlug,
  siteAccountKey,
  siteName,
  asParam,
  previewName,
  isPreview,
  pager,
}: {
  initialDraft: DraftView;
  initialFiles: FileView[];
  initialVendorName: string | null;
  activeCodes: SiteGlCode[];
  initialUsual: { codes: UsualCode[]; singleCodeFill: UsualCode | null; sampleSize: number };
  siteSlug: string;
  siteAccountKey: string;
  siteName: string;
  asParam: string | null;
  previewName: string | null;
  isPreview: boolean;
  pager: Pager;
}) {
  const router = useRouter();
  const isPhone = useIsPhone();
  const keyboardOffset = useKeyboardOffset();
  const [draft, setDraft] = useState<DraftView>(initialDraft);
  const [files, setFiles] = useState<FileView[]>(initialFiles);
  const [vendorName, setVendorName] = useState<string | null>(initialVendorName);
  // Train 2b correction 4.5: client fetches the signed URL only
  // for the active file, and again if the draw fails.
  const [viewUrls, setViewUrls] = useState<Record<string, string>>({});
  const [usual, setUsual] = useState(initialUsual);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [errors, setErrors] = useState<CheckResult["errors"]>([]);
  const [copyMatch, setCopyMatch] = useState<CopyMatchView | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "offline" | "stopped">("idle");
  const [checking, setChecking] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [pageMenuOpen, setPageMenuOpen] = useState(false);
  const [calOpen, setCalOpen] = useState(false);
  const [pagePhoneSheetOpen, setPagePhoneSheetOpen] = useState(false);

  // Refs for focus management.
  const stagedRef = useRef<Staged>({});
  const inflightRef = useRef<boolean>(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backoffAttemptRef = useRef<number>(0);
  const draftRef = useRef<DraftView>(draft);
  const invNumRef = useRef<HTMLInputElement | null>(null);
  const invDateRef = useRef<HTMLInputElement | null>(null);
  const totalRef = useRef<HTMLInputElement | null>(null);
  const vendorButtonRef = useRef<HTMLButtonElement | null>(null);
  const moreTriggerRef = useRef<HTMLButtonElement | null>(null);
  const morePhoneTriggerRef = useRef<HTMLButtonElement | null>(null);
  // Train 2b round-2 fix #2: the 9-in-10 fill mark lives here,
  // outside the coding row, so it survives server round-trips
  // (patchDraft strips extra fields and flush() replaces `draft`
  // with the server response). Set true only by the fill helper
  // when it plants or updates the auto line; cleared by any
  // user-driven coding action (chip, Add a code, Put the rest,
  // updateLine, removeLine).
  const fillMarkedRef = useRef<boolean>(false);
  // Train 2b fix 1 / 2.3. check() waits on the save itself via
  // waitForCheckAction. The ref mirrors saveState so the waiter
  // sees "stopped" the moment the retry loop gives up. The
  // listener set is signalled from flush()'s finally so the
  // waiter re-decides on every tick of save-loop work; no fixed
  // sleeps anywhere in the check path.
  const saveStateRef = useRef<"idle" | "saving" | "offline" | "stopped">("idle");
  const saveSettledListenersRef = useRef<Set<() => void>>(new Set());
  const pageTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sendButtonRef = useRef<HTMLButtonElement | null>(null);
  const addFileInputRef = useRef<HTMLInputElement | null>(null);
  const replaceFileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { draftRef.current = draft; }, [draft]);

  // Fire every one-shot save-settled listener. Called from flush()
  // on every path (ok, conflict, 500, catch) in its finally, and
  // from the saveStateRef mirror effect so the waiter can see
  // "stopped" on the next tick after setSaveState("stopped").
  const notifySaveSettled = useCallback(() => {
    // Copy first so a listener that unregisters itself during the
    // call does not mutate the Set we're iterating.
    const fns = Array.from(saveSettledListenersRef.current);
    for (const fn of fns) fn();
  }, []);

  // Keep the saveState mirror in sync so the check-waiter reads
  // the terminal "stopped" without a re-render dependency. Signal
  // the waiter too: setSaveState("stopped") fires inside flush's
  // retry path, which happens BEFORE the ref catches up; waking
  // the waiter after the ref lands lets it decide "stop".
  useEffect(() => {
    saveStateRef.current = saveState;
    notifySaveSettled();
  }, [saveState, notifySaveSettled]);

  // Train 2b round-2 fix #1. An effect runs on first mount no
  // matter what - so the re-sync's writeLocal(false) was deleting
  // the device copy before the flush-dirty-patch effect could
  // read it. A mount guard skips the first run. From the second
  // run onward (initialDraft.updated_at or .id changing AFTER
  // mount - a router.refresh() on a 409, or page.tsx re-running
  // for the same draft), the component adopts the server's
  // newest state and drops the staged patch.
  //
  // Verified by code-read: hasMountedRef starts false; the
  // if-block below returns BEFORE writeLocal is called; the
  // flush-dirty-patch effect further down reads the device copy
  // on its own first mount and schedules a flush when the dirty
  // flag is set. Round-trip: type into the invoice number box
  // (onInvNumChange -> stage -> writeLocal(true), the key is on
  // the device); reload (hard navigation remounts this
  // component); on the new mount hasMountedRef is false so the
  // re-sync skips; the flush-dirty-patch effect reads the key
  // and schedules the flush; the patch reaches the server.
  const hasMountedRef = useRef(false);
  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      return;
    }
    setDraft(initialDraft);
    setInvNumLocal(initialDraft.invoice_number ?? "");
    setInvDateLocal(toBoxDate(initialDraft.invoice_date));
    setTotalLocal(initialDraft.total_amount != null ? initialDraft.total_amount.toFixed(2) : "");
    stagedRef.current = {};
    writeLocal(false);
    backoffAttemptRef.current = 0;
    setErrors([]);
    setCopyMatch(null);
    setSaveState("idle");
    fillMarkedRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDraft.id, initialDraft.updated_at]);

  // Train 2b fix-before-push #5: C11 asks for the cursor to be in
  // the next draft's number box on arrival. With key={draftId} on
  // the page, each new sitting mounts fresh; this effect runs
  // once per mount and lands focus there. If there is no vendor
  // yet the vendor button is more useful, so prefer that.
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (!initialDraft.vendor_id) vendorButtonRef.current?.focus();
      else invNumRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const asQ = asParam ? `?as=${encodeURIComponent(asParam)}` : "";
  const asQAmp = asParam ? `&as=${encodeURIComponent(asParam)}` : "";
  const draftId = initialDraft.id;

  // On mount: flush any dirty local patch.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const scheduleFlush = useCallback((delay: number = SAVE_DEBOUNCE_MS) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { void flush(); }, delay);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flush = useCallback(async () => {
    if (inflightRef.current) return;
    const body = stagedRef.current;
    if (!body || Object.keys(body).length === 0) return;
    if (isPreview) {
      setSaveState("stopped");
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
        backoffAttemptRef.current = 0;
        writeLocal(false);
      } else if (res.status === 409) {
        // Train 2b fix-before-push #2: one toast, one reload.
        // The 409 means another tab got in first, so our view -
        // and anything we had staged on top of it - is stale.
        // Drop the staged patch, drop the retry backoff, toast
        // once, and refresh. The initialDraft.updated_at effect
        // above re-adopts the server state on the next render.
        stagedRef.current = {};
        writeLocal(false);
        backoffAttemptRef.current = 0;
        setSaveState("idle");
        toast("This invoice changed in another tab. Showing the newest.", { tone: "ink" });
        router.refresh();
        return; // skip the finally reschedule path
      } else if (res.status === 500) {
        // Train 2b correction 4.2: DB error, not a conflict. Retry
        // a few times with growing backoff; then stop and say so.
        stagedRef.current = { ...body, ...stagedRef.current };
        writeLocal(true);
        const attempt = backoffAttemptRef.current;
        if (attempt < SAVE_BACKOFF_MS.length) {
          backoffAttemptRef.current = attempt + 1;
          setSaveState("saving");
          scheduleFlush(SAVE_BACKOFF_MS[attempt]);
        } else {
          setSaveState("stopped");
        }
      } else {
        setSaveState("stopped");
      }
    } catch {
      // Offline. Keep the patch, let the online listener retry.
      setSaveState("offline");
      stagedRef.current = { ...body, ...stagedRef.current };
      writeLocal(true);
    } finally {
      inflightRef.current = false;
      if (Object.keys(stagedRef.current).length > 0 && saveStateRef.current !== "stopped") {
        scheduleFlush();
      }
      // Train 2b fix 1 / 2.3: wake any check-waiter so it re-runs
      // the decision. Fires on every finally path (ok, conflict,
      // 500, offline, early returns above).
      notifySaveSettled();
    }
  }, [asQ, draftId, isPreview, notifySaveSettled, router, scheduleFlush, writeLocal]);

  const stage = useCallback(<K extends keyof Staged>(key: K, value: Staged[K]) => {
    stagedRef.current = { ...stagedRef.current, [key]: value };
    writeLocal(true);
    scheduleFlush();
  }, [scheduleFlush, writeLocal]);

  // Online / offline listeners. On coming online, retry.
  useEffect(() => {
    const on = () => { if (saveState === "offline" || saveState === "stopped") { backoffAttemptRef.current = 0; void flush(); } };
    const off = () => setSaveState("offline");
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, [flush, saveState]);

  // ─── Field state ────────────────────────────────────────────────
  // Train 2b correction 5: date box always shows MM/DD/YYYY after
  // a reload. toBoxDate converts the stored ISO without timezone shift.
  const [invNumLocal, setInvNumLocal] = useState<string>(draft.invoice_number ?? "");
  const [invDateLocal, setInvDateLocal] = useState<string>(toBoxDate(draft.invoice_date));
  const [totalLocal, setTotalLocal] = useState<string>(
    draft.total_amount != null ? draft.total_amount.toFixed(2) : "",
  );

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
    // Future dates: block the save - do not stage; UI shows the
    // inline bad hint.
    if (parsed.iso && parsed.future) {
      // Still stage the raw string? No - staging invoice_date=null
      // when the user types a nonsense date avoids half-saved state.
      stage("invoice_date", null);
      return;
    }
    stage("invoice_date", parsed.iso);
  };

  const onTotalChange = (v: string) => {
    setTotalLocal(v);
    const parsed = parseMoneyInput(v);
    stage("total_amount", parsed);
    // 9-in-10 fill (train 2b round-2 fix #2). The mark comes from
    // fillMarkedRef (outside the row) and flows back out from the
    // helper. The helper returns the SAME coding reference when
    // nothing changed, so an unchanged total does not stage a
    // save; the `if (next !== current)` guard below reads that.
    if (usual.singleCodeFill) {
      const current = draft.gl_breakdown ?? [];
      const result = applySingleCodeFill(parsed, current, usual.singleCodeFill, fillMarkedRef.current);
      fillMarkedRef.current = result.isFilled;
      if (result.coding !== current) {
        const next = result.coding as GlLineDraft[];
        stage("gl_breakdown", next);
        setDraft((d) => ({ ...d, gl_breakdown: next }));
      }
    }
  };

  const onKindFlip = () => {
    const next: InvoiceKind = draft.type === "invoice" ? "credit" : "invoice";
    stage("type", next);
    setDraft((d) => ({ ...d, type: next }));
  };

  const pickCalendarDate = (iso: string) => {
    const box = toBoxDate(iso);
    setInvDateLocal(box);
    stage("invoice_date", iso);
    setCalOpen(false);
    // Focus moves to the total box after a pick.
    window.setTimeout(() => totalRef.current?.focus(), 0);
  };

  const onVendorPicked = async (v: { id: string; name: string }) => {
    setVendorName(v.name);
    setPickerOpen(false);
    stage("vendor_id", v.id);
    setDraft((d) => ({ ...d, vendor_id: v.id }));
    try {
      const res = await fetch(
        `/api/invoices/gl-codes?site=${encodeURIComponent(siteSlug)}&vendor_id=${encodeURIComponent(v.id)}${asQAmp}`,
      );
      if (res.ok) {
        const body = (await res.json()) as { usual: typeof usual };
        if (body.usual) setUsual(body.usual);
      }
    } catch { /* ignore */ }
    // Focus moves to the invoice number box after a vendor is picked.
    window.setTimeout(() => invNumRef.current?.focus(), 0);
  };

  // ─── Coding ─────────────────────────────────────────────────────
  const gl = draft.gl_breakdown ?? [];
  const totalNum = draft.total_amount ?? null;

  const updateGl = (next: GlLineDraft[]) => {
    stage("gl_breakdown", next);
    setDraft((d) => ({ ...d, gl_breakdown: next }));
  };
  // Every user-driven coding action clears the fill mark (train 2b
  // round-2 fix #2). The fill helper reads the mark on the next
  // total keystroke and hands off.
  const putAllToCode = (code: UsualCode) => {
    if (totalNum == null) { toast("Type the total first.", { tone: "ink" }); return; }
    fillMarkedRef.current = false;
    updateGl([{ code: code.code, name: code.name, amount: totalNum }]);
  };
  const addSplitLine = (code: UsualCode) => {
    fillMarkedRef.current = false;
    const left = totalNum != null ? leftToCode(totalNum, gl) : 0;
    const amount = left > 0 ? Math.round(left * 100) / 100 : 0;
    updateGl([...gl, { code: code.code, name: code.name, amount }]);
  };
  const addEmptyRow = () => {
    fillMarkedRef.current = false;
    updateGl([...gl, { code: "", name: "", amount: 0 }]);
  };
  const putRestOn = (code: string, name: string) => {
    fillMarkedRef.current = false;
    const left = totalNum != null ? leftToCode(totalNum, gl) : 0;
    if (left <= 0) return;
    updateGl([...gl, { code, name, amount: Math.round(left * 100) / 100 }]);
  };
  const updateLine = (idx: number, patch: Partial<GlLineDraft>) => {
    fillMarkedRef.current = false;
    updateGl(gl.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  };
  const removeLine = (idx: number) => {
    fillMarkedRef.current = false;
    updateGl(gl.filter((_, i) => i !== idx));
  };

  const leftNow = totalNum != null ? leftToCode(totalNum, gl) : null;
  const addedUp = addsUp(totalNum, gl);
  // Top code for "Put the rest on {code}". Prefer the vendor's
  // singleCodeFill; then the first already-coded line; then null.
  const topCode: { code: string; name: string } | null =
    usual.singleCodeFill
      ? { code: usual.singleCodeFill.code, name: usual.singleCodeFill.name }
      : gl.find((l) => l.code)
        ? { code: gl.find((l) => l.code)!.code, name: gl.find((l) => l.code)!.name }
        : null;

  // ─── Files (page) ───────────────────────────────────────────────
  const [activeFileId, setActiveFileId] = useState<string | null>(initialFiles[0]?.id ?? null);
  const activeFile = useMemo(() => files.find((f) => f.id === activeFileId) ?? null, [files, activeFileId]);
  const activeIndex = activeFile ? files.findIndex((f) => f.id === activeFile.id) : -1;

  const fetchViewUrl = useCallback(async (fileId: string) => {
    try {
      const u = `/api/invoices/files/${encodeURIComponent(fileId)}/view?draft=${encodeURIComponent(draftId)}${asQAmp}`;
      const res = await fetch(u);
      if (!res.ok) return;
      const body = (await res.json()) as { url: string };
      if (body.url) setViewUrls((m) => ({ ...m, [fileId]: body.url }));
    } catch { /* PdfPage / img onError will call back */ }
  }, [asQAmp, draftId]);

  useEffect(() => {
    if (activeFileId && !viewUrls[activeFileId]) {
      void fetchViewUrl(activeFileId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFileId]);

  const handleViewExpired = useCallback(() => {
    if (activeFileId) {
      setViewUrls((m) => { const n = { ...m }; delete n[activeFileId]; return n; });
      void fetchViewUrl(activeFileId);
    }
  }, [activeFileId, fetchViewUrl]);

  const rotateActive = async () => {
    if (!activeFile || isPreview) return;
    const next = ((activeFile.rotation + 90) % 360) as 0 | 90 | 180 | 270;
    const res = await fetch(
      `/api/invoices/files/${activeFile.id}?draft=${draftId}${asQAmp}`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ rotation: next }) },
    );
    if (res.ok) {
      const out = (await res.json()) as { file: FileView };
      setFiles((fs) => fs.map((f) => (f.id === out.file.id ? out.file : f)));
      toast("Rotated.", { tone: "ink" });
    }
  };

  const removeActive = async (): Promise<void> => {
    if (!activeFile || isPreview) return;
    const snapshot = activeFile;
    setFiles((fs) => fs.filter((f) => f.id !== snapshot.id));
    setActiveFileId((prev) => {
      if (prev !== snapshot.id) return prev;
      const next = files.filter((f) => f.id !== snapshot.id)[0];
      return next?.id ?? null;
    });
    const res = await fetch(
      `/api/invoices/files/${snapshot.id}/remove?draft=${draftId}${asQAmp}`,
      { method: "POST" },
    );
    if (!res.ok) {
      setFiles((fs) => [...fs, snapshot]);
      toast("Could not remove that. Try again.", { tone: "block" });
      return;
    }
    toast("File removed. What you typed is still here.", {
      tone: "ink",
      undo: async () => {
        const r = await fetch(`/api/invoices/files/${snapshot.id}/unremove?draft=${draftId}${asQAmp}`, { method: "POST" });
        if (r.ok) {
          const out = (await r.json()) as { file: FileView };
          setFiles((fs) => [out.file, ...fs.filter((f) => f.id !== out.file.id)]);
          setActiveFileId(out.file.id);
        } else {
          toast("Could not put it back.", { tone: "block" });
        }
      },
    });
  };

  // "Add pages to it" and "Replace the file" both reuse the uploads
  // route with this draft's id. For Replace the new file is added
  // and confirmed first; only after the new file row lands do we
  // mark the old one removed (correction 12).
  const uploadOneTo = useCallback(async (f: File, mode: "add" | "replace") => {
    const oldFile = activeFile;
    const nameLower = f.name.toLowerCase();
    if (f.size > 52_428_800) { toast("Over 50 MB.", { tone: "block" }); return; }
    if (nameLower.endsWith(".heic") || nameLower.endsWith(".heif")) {
      toast("Save it as a PDF or a JPEG and add it again.", { tone: "block" });
      return;
    }
    const r2 = await fetch(`/api/invoices/uploads${asQ}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draft_id: draftId, file_name: f.name, size_bytes: f.size, mime_type_hint: f.type }),
    });
    if (!r2.ok) { toast("Could not prepare the upload.", { tone: "block" }); return; }
    const slot = (await r2.json()) as { file_id: string; signed_url: string };

    const put = await fetch(slot.signed_url, { method: "PUT", body: f, headers: { "content-type": f.type || "application/octet-stream" } });
    if (!put.ok) { toast("Upload was cut off. Try again.", { tone: "block" }); return; }

    const r4 = await fetch(`/api/invoices/files${asQ}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draft_id: draftId, file_id: slot.file_id, file_name: f.name }),
    });
    if (!r4.ok) { toast("Could not read the file.", { tone: "block" }); return; }
    const out = (await r4.json()) as { file: FileView };
    setFiles((fs) => [...fs, out.file]);
    if (mode === "replace" && oldFile) {
      // Train 2b fix-before-push #9: the remove call's answer
      // decides the toast. A failure leaves both files on the
      // draft (the new one is already added); we say so plainly
      // rather than claiming the replace worked.
      const rm = await fetch(`/api/invoices/files/${oldFile.id}/remove?draft=${draftId}${asQAmp}`, { method: "POST" });
      if (rm.ok) {
        setFiles((fs) => fs.filter((f) => f.id !== oldFile.id));
        setActiveFileId(out.file.id);
        toast("File replaced. What you typed is still here.", { tone: "ink" });
      } else {
        // The new file is already on the draft; the old one is
        // still there too. The user can remove either one by hand
        // from Change the page.
        setActiveFileId(out.file.id);
        toast("Added the new file, but the old one could not be removed. Both are on this invoice.", { tone: "block" });
      }
    } else {
      setActiveFileId(out.file.id);
      toast("Page added.", { tone: "ink" });
    }
  }, [activeFile, asQ, asQAmp, draftId]);

  // ─── Check and send ─────────────────────────────────────────────
  const invDateErrorInline =
    invDateParsed.iso && invDateParsed.future
      ? "That is in the future. Check the year."
      : null;
  const show60DayPrompt =
    invDateParsed.iso
    && invDateParsed.moreThan60DaysBack
    && !draft.answers.date_confirmed_at_more_than_60_days;

  const invDateErr = errors.find((e) => e.field === "invoice_date" || e.field === "date_more_than_60") ?? null;
  const invNumErr = errors.find((e) => e.field === "invoice_number") ?? null;
  const totalErr = errors.find((e) => e.field === "total_amount") ?? null;
  const vendorErr = errors.find((e) => e.field === "vendor_id") ?? null;
  const codingErr = errors.find((e) => e.field === "gl_breakdown") ?? null;
  const fileErr = errors.find((e) => e.field === "files") ?? null;

  const focusField = useCallback((field: string) => {
    switch (field) {
      case "vendor_id": vendorButtonRef.current?.focus(); break;
      case "invoice_number": invNumRef.current?.focus(); break;
      case "invoice_date":
      case "date_more_than_60":
        invDateRef.current?.focus(); break;
      case "total_amount": totalRef.current?.focus(); break;
      default: sendButtonRef.current?.focus();
    }
  }, []);

  const check = async () => {
    if (checking) return;
    setChecking(true);
    try {
      // Train 2b fix 1 / 2.3: wait on the save itself.
      //
      // If the retry loop is still running, let it finish; if it
      // gave up (saveState=stopped), do not run the check - the
      // save line already carries the reason. If there is staged
      // typing (user pressed Enter mid-flight), kick the queue
      // and wait on it.
      if (Object.keys(stagedRef.current).length > 0 && !inflightRef.current) {
        // Nothing in flight but typing is queued: start the next
        // save so the waiter has something to wait on.
        void flush();
      }
      const decision = await waitForCheckAction({
        getState: () => ({
          inFlight: inflightRef.current,
          stagedKeys: Object.keys(stagedRef.current).length,
          stopped: saveStateRef.current === "stopped",
        }),
        onSettled: (fn) => {
          saveSettledListenersRef.current.add(fn);
          return () => saveSettledListenersRef.current.delete(fn);
        },
      });
      if (decision === "stop") {
        // The save line already explains. Keep the button on
        // "Checking" would be a lie - flip it back by falling
        // through to the finally.
        return;
      }

      const res = await fetch(`/api/invoices/drafts/${draftId}/check${asQ}`, { method: "POST" });
      if (!res.ok) {
        setErrors([{ field: "files", message: "Could not run the check." }]);
        return;
      }
      const result = (await res.json()) as CheckResult;
      setErrors(result.errors);
      setCopyMatch(result.copy_match ?? null);
      if (result.ready) {
        toast("Ready. Sending is switched on in the next update.", { tone: "good" });
        if (result.next_draft_id) {
          router.push(`/invoices?site=${siteSlug}&draft=${result.next_draft_id}${asQAmp}`);
        } else {
          router.push(`/invoices?site=${siteSlug}${asQAmp}`);
        }
      } else {
        // Move focus to the first field in error.
        const first = result.errors[0]?.field;
        if (first) window.setTimeout(() => focusField(first), 0);
      }
    } finally {
      setChecking(false);
    }
  };

  // Enter in the total box triggers Check and send (correction 12).
  const onTotalKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void check();
    }
  };

  const confirm60Days = () => {
    const ans = { ...draft.answers, date_confirmed_at_more_than_60_days: true as const };
    stage("answers", ans);
    setDraft((d) => ({ ...d, answers: ans }));
    window.setTimeout(() => totalRef.current?.focus(), 0);
  };

  const discard = async () => {
    const res = await fetch(`/api/invoices/drafts/${draftId}/discard${asQ}`, { method: "POST" });
    if (res.ok) {
      toast("Removed.", {
        tone: "ink",
        undo: async () => {
          const r = await fetch(`/api/invoices/drafts/${draftId}/undo${asQ}`, { method: "POST" });
          if (r.ok) {
            router.push(`/invoices?site=${siteSlug}&draft=${draftId}${asQAmp}`);
          } else {
            toast("Could not put it back.", { tone: "block" });
          }
        },
      });
      if (pager.nextDraftId) router.push(`/invoices?site=${siteSlug}&draft=${pager.nextDraftId}${asQAmp}`);
      else router.push(`/invoices?site=${siteSlug}${asQAmp}`);
    }
  };

  // C9 copy-stop block ways out. Train 2b fix-before-push #10:
  // after the answer is saved, run the check again so the person
  // does not have to press Check and send a second time. The
  // check() call flushes any staged patch first, so the server
  // sees the new answer before deciding.
  const copyRemove = () => { void discard(); setCopyMatch(null); };
  const copyDifferent = () => {
    const ans = { ...draft.answers, is_different_invoice: true as const };
    stage("answers", ans);
    setDraft((d) => ({ ...d, answers: ans }));
    setCopyMatch(null);
    setErrors((es) => es.filter((e) => e.field !== "copy"));
    window.setTimeout(() => void check(), 100);
  };
  const copyCreditFor = () => {
    if (!copyMatch?.submission_id) return;
    const ans = { ...draft.answers, is_credit_for: copyMatch.submission_id };
    stage("answers", ans);
    stage("type", "credit");
    setDraft((d) => ({ ...d, answers: ans, type: "credit" }));
    setCopyMatch(null);
    setErrors((es) => es.filter((e) => e.field !== "copy"));
    window.setTimeout(() => void check(), 100);
  };

  const canSave = !isPreview;

  // ─── Render ─────────────────────────────────────────────────────
  const saveLine =
    saveState === "saving" ? "Saving"
    : saveState === "offline" ? "No signal. Your typing is kept on this device."
    : saveState === "stopped" ? "Not saved. Changes are kept on this device."
    : "Saved";

  // Train 2b fix-before-push #7 (F3 second half). A visually-
  // hidden sentence spells out why every disabled control is
  // disabled when the viewer is previewing someone. Each disabled
  // control carries aria-describedby="preview-reason" so a screen
  // reader announces the reason.
  const previewDescId = isPreview ? "preview-reason" : undefined;
  const describedBy = (errId: string | undefined): string | undefined => {
    const parts = [errId, previewDescId].filter((s): s is string => Boolean(s));
    return parts.length === 0 ? undefined : parts.join(" ");
  };

  return (
    <div className="kf-invoices-surface kf-inv-sitting-wrap">
      {previewName ? <OwnerPreviewBanner name={previewName} exitHref="/invoices" /> : null}
      {isPreview ? (
        <span id="preview-reason" className="kf-sr-only">
          Owner preview. Changes are not saved.
        </span>
      ) : null}

      {/* D1: plain phone head carrying the vendor name as the
          H2 heading and the pager under it. The desk C1 slim top
          row renders at desk widths. */}
      <div className="kf-inv-sitting__phonehead kf-only-phone">
        <div className="kf-inv-sitting__phonehead__row">
          <Link
            className="kf-inv-sitting__phonehead__back"
            href={`/invoices?site=${siteSlug}${asQAmp}`}
            aria-label="Back to Capture"
          >
            <ChevronLeft size={20} aria-hidden />
          </Link>
          <div className="kf-inv-sitting__phonehead__labels">
            <span className="kf-inv-sitting__phonehead__sub">
              Invoice {pager.position} of {pager.total} · {siteAccountKey}
            </span>
            <h2 className="kf-inv-sitting__phonehead__title">
              {vendorName ?? (draft.type === "credit" ? "New credit" : "New invoice")}
            </h2>
          </div>
          <div className="kf-inv-sitting__phonehead__morewrap">
            <button
              ref={morePhoneTriggerRef}
              type="button"
              className="kf-inv-sitting__phonehead__more"
              aria-haspopup="menu"
              aria-expanded={moreMenuOpen ? true : undefined}
              aria-label="More for this invoice"
              onClick={() => setMoreMenuOpen((v) => !v)}
            >
              <MoreHorizontal size={20} aria-hidden />
            </button>
            {/* Train 2b fix 1 / 2.1: exactly one Menu mounts for
                the layout on screen. Before this, both the phone
                head and the desk top row mounted a Menu off the
                same flag; the hidden one's outside-click handler
                fired when the visible one's item was pressed and
                unmounted both before the click landed, so Delete
                did nothing. useIsPhone() picks the single mount;
                useIsPhone() returns false on the server so SSR
                output is stable. */}
            {moreMenuOpen && isPhone ? (
              <Menu
                label="More for this invoice"
                anchorRef={morePhoneTriggerRef}
                align="down-right"
                onClose={() => setMoreMenuOpen(false)}
                items={canSave ? [
                  {
                    key: "delete",
                    label: "Delete this invoice",
                    icon: <Trash2 size={18} aria-hidden />,
                    onPick: () => void discard(),
                  },
                ] : []}
              />
            ) : null}
          </div>
        </div>
      </div>

      {/* C1: slim top row (desk) + D1 phone head */}
      <div className="kf-inv-sitting__nav kf-only-desktop">
        <div className="kf-inv-sitting__nav__left">
          <Link href={`/invoices?site=${siteSlug}${asQAmp}`} className="kf-btn kf-btn--sm kf-btn--line">
            <ChevronLeft size={16} aria-hidden /> Back
          </Link>
          <span className="kf-inv-sitting__nav__site">
            <span className="kf-inv-sitting__nav__key">{siteAccountKey}</span>
            <span className="kf-inv-sitting__nav__name">· {siteName}</span>
          </span>
        </div>
        <div className="kf-inv-sitting__nav__right">
          <span className="kf-inv-sitting__nav__pager" aria-label={`Invoice ${pager.position} of ${pager.total}`}>
            <PagerButton to={pager.prevDraftId} siteSlug={siteSlug} asQAmp={asQAmp} label="Previous" icon={<ChevronLeft size={16} aria-hidden />} />
            {pager.position} of {pager.total}
            <PagerButton to={pager.nextDraftId} siteSlug={siteSlug} asQAmp={asQAmp} label="Next" icon={<ChevronRight size={16} aria-hidden />} />
          </span>
          <div className="kf-inv-sitting__nav__more">
            <button
              ref={moreTriggerRef}
              type="button"
              className="kf-inv-sitting__more-trigger"
              aria-haspopup="menu"
              aria-expanded={moreMenuOpen ? true : undefined}
              aria-label="More for this invoice"
              onClick={() => setMoreMenuOpen((v) => !v)}
            >
              <MoreHorizontal size={18} aria-hidden />
            </button>
            {moreMenuOpen && !isPhone ? (
              <Menu
                label="More for this invoice"
                anchorRef={moreTriggerRef}
                align="down-right"
                onClose={() => setMoreMenuOpen(false)}
                items={canSave ? [
                  {
                    key: "delete",
                    label: "Delete this invoice",
                    icon: <Trash2 size={18} aria-hidden />,
                    onPick: () => void discard(),
                  },
                ] : []}
              />
            ) : null}
          </div>
        </div>
      </div>

      <div className="kf-inv-sitting">
        {/* C3: page box */}
        <section className="kf-inv-sitting__page">
          <div className="kf-inv-sitting__page-tools">
            <span className="kf-inv-sitting__page-tools__name">
              {activeFile?.file_name ?? "No file yet"}
              {files.length > 1 ? ` · Page ${activeIndex + 1} of ${files.length}` : ""}
            </span>
            <div className="kf-inv-sitting__page-tools__actions kf-only-desktop">
              <button
                type="button"
                className="kf-btn kf-btn--sm kf-btn--line"
                aria-pressed={zoomed ? true : undefined}
                onClick={() => setZoomed((z) => !z)}
                disabled={!activeFile}
              >
                Zoom
              </button>
              {canSave && activeFile ? (
                <>
                  <button
                    type="button"
                    className="kf-btn kf-btn--sm kf-btn--line"
                    onClick={rotateActive}
                  >
                    <RotateCw size={14} aria-hidden /> Rotate
                  </button>
                  <div className="kf-inv-sitting__page-tools__menuwrap">
                    <button
                      ref={pageTriggerRef}
                      type="button"
                      className="kf-btn kf-btn--sm kf-btn--line"
                      aria-haspopup="menu"
                      aria-expanded={pageMenuOpen ? true : undefined}
                      onClick={() => setPageMenuOpen((v) => !v)}
                    >
                      <Files size={14} aria-hidden /> Change the page
                      <ChevronDown size={14} aria-hidden />
                    </button>
                    {pageMenuOpen ? (
                      <Menu
                        label="Change the page"
                        anchorRef={pageTriggerRef}
                        onClose={() => setPageMenuOpen(false)}
                        items={[
                          {
                            key: "add",
                            label: "Add pages to it",
                            icon: <Plus size={18} aria-hidden />,
                            onPick: () => addFileInputRef.current?.click(),
                          },
                          {
                            key: "replace",
                            label: "Replace the file",
                            icon: <Upload size={18} aria-hidden />,
                            onPick: () => replaceFileInputRef.current?.click(),
                          },
                          {
                            key: "remove",
                            label: "Remove the file",
                            icon: <Trash2 size={18} aria-hidden />,
                            onPick: () => void removeActive(),
                          },
                        ]}
                      />
                    ) : null}
                  </div>
                </>
              ) : null}
            </div>
            {/* D5 phone page tools: Replace only. The one-line
                explanation lives just below. */}
            <div className="kf-inv-sitting__page-tools__actions kf-only-phone">
              {canSave ? (
                <button
                  type="button"
                  className="kf-btn kf-btn--sm kf-btn--line"
                  onClick={() => replaceFileInputRef.current?.click()}
                >
                  <Upload size={14} aria-hidden /> Replace the file
                </button>
              ) : null}
            </div>
          </div>
          {/* D5 line, phone-only, only when there is a file to
              replace. */}
          <div className="kf-only-phone">
            {activeFile ? (
              <p className="kf-inv-sitting__hint">
                To add, turn or remove pages, use a computer.
              </p>
            ) : null}
          </div>

          {files.length > 1 ? (
            <div className="kf-inv-sitting__page-pager" role="group" aria-label="Pages">
              {files.map((f, i) => (
                <button
                  key={f.id}
                  type="button"
                  className={`kf-inv-sitting__page-pager__btn${f.id === activeFileId ? " is-active" : ""}`}
                  aria-current={f.id === activeFileId ? "page" : undefined}
                  onClick={() => setActiveFileId(f.id)}
                >
                  {i + 1}
                </button>
              ))}
            </div>
          ) : null}

          <div className={`kf-inv-sitting__canvas${zoomed ? " is-zoom" : ""}`} tabIndex={0}>
            {activeFile == null ? (
              <div className="kf-inv-sitting__nofile">
                <ImageIcon size={32} strokeWidth={1.5} aria-hidden />
                <p className="kf-inv-sitting__nofile__title">No page on this invoice</p>
                <p className="kf-inv-sitting__hint">What you typed is still here. Add the right file to send it.</p>
                {canSave ? (
                  <button
                    type="button"
                    className="kf-btn kf-btn--primary"
                    onClick={() => replaceFileInputRef.current?.click()}
                  >
                    Choose a file
                  </button>
                ) : null}
              </div>
            ) : activeFile.mime_type === "application/pdf" ? (
              viewUrls[activeFile.id] ? (
                <PdfPage url={viewUrls[activeFile.id]} rotation={activeFile.rotation} onExpired={handleViewExpired} />
              ) : (
                <p className="kf-inv-sitting__hint">Preparing the page...</p>
              )
            ) : (
              viewUrls[activeFile.id] ? (
                <img
                  src={viewUrls[activeFile.id]}
                  alt="Invoice page"
                  style={{ transform: `rotate(${activeFile.rotation}deg)` }}
                  onError={handleViewExpired}
                />
              ) : (
                <p className="kf-inv-sitting__hint">Preparing the page...</p>
              )
            )}
          </div>

          <input
            ref={addFileInputRef}
            type="file"
            accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              if (f) void uploadOneTo(f, "add");
              e.currentTarget.value = "";
            }}
          />
          <input
            ref={replaceFileInputRef}
            type="file"
            accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              if (f) void uploadOneTo(f, "replace");
              e.currentTarget.value = "";
            }}
          />

          {/* D2 phone: "See the page" opens a full-sheet view. */}
          <div className="kf-only-phone">
            {activeFile ? (
              <button
                type="button"
                className="kf-btn kf-btn--sm kf-btn--line kf-inv-sitting__page-full"
                onClick={() => setPagePhoneSheetOpen(true)}
              >
                See the page
              </button>
            ) : null}
          </div>
        </section>

        {/* The form */}
        <section className="kf-inv-sitting__form kf-card">
          {/* C4 Vendor */}
          <div className="kf-inv-sitting__field">
            <label htmlFor="inv-vendor">Vendor</label>
            <button
              id="inv-vendor"
              ref={vendorButtonRef}
              type="button"
              data-vendor
              aria-haspopup="dialog"
              aria-invalid={vendorErr ? true : false}
              aria-describedby={describedBy(vendorErr ? "err-vendor" : undefined)}
              onClick={() => setPickerOpen(true)}
              disabled={isPreview}
            >
              {vendorName ?? "Pick the vendor"}
              <ChevronDown size={16} aria-hidden />
            </button>
            {vendorErr ? <span id="err-vendor" className="kf-inv-sitting__err">{vendorErr.message}</span> : null}
          </div>

          {/* C5 kind line with 48px tap area on the link */}
          <p className="kf-inv-sitting__kind">
            {draft.type === "invoice" ? "This is an invoice." : "This is a credit."}
            <button type="button" className="kf-inv-sitting__kind-link" onClick={onKindFlip} disabled={isPreview} aria-describedby={previewDescId}>
              {draft.type === "invoice" ? "It is a credit" : "It is an invoice"}
            </button>
          </p>

          {/* C6 number, date, total in that order */}
          <div className="kf-inv-sitting__field">
            <label htmlFor="inv-num">{draft.type === "credit" ? "Credit number" : "Invoice number"}</label>
            <input
              id="inv-num"
              ref={invNumRef}
              value={invNumLocal}
              onChange={(e) => onInvNumChange(e.currentTarget.value)}
              aria-invalid={invNumErr ? true : false}
              aria-describedby={describedBy(invNumErr ? "err-num" : undefined)}
              maxLength={50}
              autoCapitalize="characters"
              autoComplete="off"
              disabled={isPreview}
            />
            {invNumErr ? <span id="err-num" className="kf-inv-sitting__err">{invNumErr.message}</span> : null}
          </div>

          <div className="kf-inv-sitting__field">
            <label htmlFor="inv-date">{draft.type === "credit" ? "Credit date" : "Invoice date"}</label>
            <div className="kf-inv-sitting__field-datewrap">
              <input
                id="inv-date"
                ref={invDateRef}
                value={invDateLocal}
                onChange={(e) => onInvDateChange(e.currentTarget.value)}
                inputMode="numeric"
                placeholder="MM/DD/YYYY"
                maxLength={10}
                aria-invalid={invDateErr || invDateErrorInline ? true : false}
                aria-describedby={describedBy(invDateErr || invDateErrorInline ? "err-date" : undefined)}
                autoComplete="off"
                disabled={isPreview}
              />
              <button
                type="button"
                className="kf-inv-sitting__field-datebtn"
                aria-label="Pick the date on a calendar"
                aria-haspopup="dialog"
                aria-expanded={calOpen ? true : undefined}
                aria-describedby={previewDescId}
                onClick={() => setCalOpen(true)}
                disabled={isPreview}
              >
                <CalIcon size={18} aria-hidden />
              </button>
            </div>
            {invDateErrorInline ? (
              <span id="err-date" className="kf-inv-sitting__err">{invDateErrorInline}</span>
            ) : invDateErr ? (
              <span id="err-date" className="kf-inv-sitting__err">{invDateErr.message}</span>
            ) : null}
            {/* 60-day confirmation */}
            {show60DayPrompt ? (
              <div className="kf-inv-sitting__sixty" role="status">
                <p>This date is more than 60 days back. Is that right?</p>
                <div className="kf-inv-sitting__sixty__btns">
                  <button
                    type="button"
                    className="kf-btn kf-btn--sm kf-btn--primary"
                    onClick={confirm60Days}
                  >
                    Yes, that is right
                  </button>
                  <button
                    type="button"
                    className="kf-btn kf-btn--sm kf-btn--line"
                    onClick={() => invDateRef.current?.focus()}
                  >
                    Fix the date
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          <div className="kf-inv-sitting__field">
            <label htmlFor="inv-total">{draft.type === "credit" ? "Credit total" : "Total"}</label>
            <div className="kf-inv-sitting__money">
              <span className="kf-inv-sitting__money__sign" aria-hidden>$</span>
              <input
                id="inv-total"
                ref={totalRef}
                value={totalLocal}
                onChange={(e) => onTotalChange(e.currentTarget.value)}
                onKeyDown={onTotalKeyDown}
                onBlur={(e) => {
                  const v = parseMoneyInput(e.currentTarget.value);
                  if (v != null) setTotalLocal(v.toFixed(2));
                }}
                inputMode="decimal"
                placeholder="0.00"
                aria-invalid={totalErr ? true : false}
                aria-describedby={describedBy(totalErr ? "err-total" : undefined)}
                autoComplete="off"
                disabled={isPreview}
              />
            </div>
            {totalParsed != null ? <span className="kf-inv-sitting__hint">{fmtUsdExact(totalParsed)}</span> : null}
            {totalErr ? <span id="err-total" className="kf-inv-sitting__err">{totalErr.message}</span> : null}
          </div>

          {/* C7 Coding */}
          <div className="kf-inv-sitting__coding">
            <h4 className="kf-inv-sitting__coding__title">
              {vendorName ? `Usual for ${vendorName}` : "Coding"}
            </h4>
            {usual.codes.length === 1 ? (
              <div className="kf-inv-sitting__coding-chips">
                <button
                  type="button"
                  className={`kf-inv-sitting__coding-chip${gl.length === 1 && gl[0].code === usual.codes[0].code && addedUp ? " is-active" : ""}`}
                  onClick={() => putAllToCode(usual.codes[0])}
                  disabled={isPreview}
                >
                  <Check size={16} aria-hidden />
                  <span>All of it to <strong>{usual.codes[0].code}</strong> {usual.codes[0].name}</span>
                </button>
              </div>
            ) : usual.codes.length > 1 ? (
              <>
                <p className="kf-inv-sitting__hint">Usual for {vendorName}. Tap to add.</p>
                <div className="kf-inv-sitting__coding-chips">
                  {usual.codes.slice(0, 6).map((c) => (
                    <button
                      key={c.code}
                      type="button"
                      className={`kf-inv-sitting__coding-chip${gl.some((l) => l.code === c.code) ? " is-active" : ""}`}
                      onClick={() => addSplitLine(c)}
                      disabled={isPreview}
                    >
                      <Plus size={16} aria-hidden />
                      <span><strong>{c.code}</strong> {c.name}</span>
                    </button>
                  ))}
                </div>
              </>
            ) : vendorName ? (
              <p className="kf-inv-sitting__hint">No history for this vendor here yet. Pick a code below.</p>
            ) : (
              <p className="kf-inv-sitting__hint">Pick the vendor to see where its invoices usually go.</p>
            )}

            <div className="kf-inv-sitting__coding-rows">
              {gl.map((line, i) => (
                <div key={i} className="kf-inv-sitting__coding-row">
                  <select
                    aria-label={`Code, line ${i + 1}`}
                    value={line.code}
                    onChange={(e) => {
                      const code = e.currentTarget.value;
                      const match = activeCodes.find((c) => c.code === code);
                      updateLine(i, { code, name: match?.name ?? line.name });
                    }}
                    disabled={isPreview}
                  >
                    <option value="">Pick a code</option>
                    {activeCodes.map((c) => (
                      <option key={c.code} value={c.code}>{c.code} · {c.name}</option>
                    ))}
                  </select>
                  <div className="kf-inv-sitting__money kf-inv-sitting__money--sm">
                    <span className="kf-inv-sitting__money__sign" aria-hidden>$</span>
                    <input
                      aria-label={`Amount, line ${i + 1}`}
                      inputMode="decimal"
                      value={Number.isFinite(line.amount) ? String(line.amount) : ""}
                      onChange={(e) => {
                        const amt = parseMoneyInput(e.currentTarget.value);
                        updateLine(i, { amount: amt ?? 0 });
                      }}
                      disabled={isPreview}
                    />
                  </div>
                  <button
                    type="button"
                    className="kf-inv-sitting__coding-row__remove"
                    aria-label={`Remove line ${i + 1}`}
                    onClick={() => removeLine(i)}
                    disabled={isPreview}
                  >
                    <Trash2 size={16} aria-hidden />
                  </button>
                </div>
              ))}
            </div>

            <div className="kf-inv-sitting__coding-add">
              <button
                type="button"
                className="kf-inv-sitting__linkbtn"
                onClick={addEmptyRow}
                disabled={isPreview}
              >
                <Plus size={16} aria-hidden /> Add a code
              </button>
              {leftNow != null && leftNow > 0 && topCode ? (
                <button
                  type="button"
                  className="kf-btn kf-btn--sm kf-btn--line"
                  onClick={() => putRestOn(topCode.code, topCode.name)}
                  disabled={isPreview}
                >
                  Put the rest, {fmtUsdExact(leftNow)}, on {topCode.code}
                </button>
              ) : null}
            </div>

            <div
              className={`kf-inv-sitting__bal${leftNow === 0 ? " is-ok" : (leftNow ?? 0) < 0 ? " is-over" : ""}`}
              aria-live="polite"
            >
              {leftNow == null ? (
                <span className="kf-inv-sitting__bal__label">Type the total first.</span>
              ) : leftNow === 0 ? (
                <span className="kf-inv-sitting__bal__ok">
                  <Check size={18} aria-hidden /> Adds up
                </span>
              ) : leftNow < 0 ? (
                <>
                  <span className="kf-inv-sitting__bal__label">Over by</span>
                  <span className="kf-inv-sitting__bal__n">{fmtUsdExact(-leftNow)}</span>
                </>
              ) : (
                <>
                  <span className="kf-inv-sitting__bal__n">{fmtUsdExact(leftNow)}</span>
                  <span className="kf-inv-sitting__bal__label">left to code</span>
                </>
              )}
            </div>

            {codingErr ? <span className="kf-inv-sitting__err">{codingErr.message}</span> : null}
          </div>

          {/* C8 lines note */}
          <p className="kf-inv-sitting__hint">Lines are read after it is sent.</p>

          {/* C9 / D6 Duplicate stop block. Phone wraps it in a
              full-sheet so it clears the keyboard; desk renders
              it inline. */}
          {copyMatch && !isPhone ? (
            <aside
              className="kf-inv-sitting__copystop"
              role="group"
              aria-label="Possible copy"
            >
              <p className="kf-inv-sitting__copystop__title">
                {copyMatch.kind === "same_invoice"
                  ? "You already sent this one"
                  : "You already have this one in your drafts"}
              </p>
              <p>
                {copyMatch.vendor_name ?? "The same vendor"}
                {copyMatch.invoice_number ? ` #${copyMatch.invoice_number}` : ""}
                {copyMatch.kind === "same_invoice" && copyMatch.invoice_date
                  ? ` on ${fmtDate(copyMatch.invoice_date, "short")}` : ""}
                .
              </p>
              <div className="kf-inv-sitting__copystop__btns">
                <button type="button" className="kf-btn kf-btn--line" onClick={copyRemove}>
                  Remove this one
                </button>
                <button type="button" className="kf-btn kf-btn--ghost" onClick={copyDifferent}>
                  It is a different invoice
                </button>
                {copyMatch.kind === "same_invoice" && copyMatch.submission_id ? (
                  <button type="button" className="kf-btn kf-btn--ghost" onClick={copyCreditFor}>
                    It is the credit for that invoice
                  </button>
                ) : null}
              </div>
            </aside>
          ) : null}

          {/* C10 Error list (above the button) */}
          {errors.length > 0 && !copyMatch ? (
            <ul className="kf-inv-sitting__errs" role="alert">
              {errors.map((e, i) => (
                <li key={i}>
                  <button
                    type="button"
                    className="kf-inv-sitting__errs__item"
                    onClick={() => focusField(e.field)}
                  >
                    <AlertTriangle size={16} aria-hidden /> {e.message}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {/* C11 Check and send + C13 save line. On phone this bar
              goes sticky + rises above the on-screen keyboard
              (correction 7 / D4) via --kb-offset. */}
          <div
            className="kf-inv-sitting__actions"
            style={isPhone ? ({ ["--kb-offset" as string]: `${keyboardOffset}px` }) as React.CSSProperties : undefined}
          >
            <button
              ref={sendButtonRef}
              type="button"
              className="kf-btn kf-btn--primary"
              onClick={() => void check()}
              disabled={checking || isPreview}
              aria-live="polite"
              aria-describedby={previewDescId}
            >
              {checking ? "Checking" : "Check and send"}
            </button>
            {/* Mini balance on phone, pinned above the keyboard so
                "left to code" stays in view while typing. */}
            {isPhone && leftNow != null ? (
              <span className={`kf-inv-sitting__actions__bal${leftNow === 0 ? " is-ok" : leftNow < 0 ? " is-over" : ""}`}>
                {leftNow === 0
                  ? "Adds up"
                  : leftNow < 0
                    ? `Over by ${fmtUsdExact(-leftNow)}`
                    : `${fmtUsdExact(leftNow)} left`}
              </span>
            ) : null}
            <span className={`kf-inv-sitting__saveline${saveState === "stopped" ? " is-bad" : ""}`}>
              {saveLine}
            </span>
          </div>
          {fileErr ? <span className="kf-inv-sitting__err">{fileErr.message}</span> : null}
        </section>
      </div>

      {/* Calendar: desk popover + phone full-sheet, same Calendar
          component inside. Correction 7 + D7. */}
      {calOpen ? (
        <Sheet
          title="Pick the date"
          onClose={() => setCalOpen(false)}
          variant="centered"
        >
          <InvCalendar
            selectedIso={invDateParsed.iso ?? draft.invoice_date}
            onPick={pickCalendarDate}
          />
        </Sheet>
      ) : null}

      {pickerOpen ? (
        <VendorPicker
          siteSlug={siteSlug}
          asParam={asParam}
          currentVendorId={draft.vendor_id}
          onPick={(v) => void onVendorPicked(v)}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}

      {/* D6 phone: copy stop as a full-width sheet so it clears
          the on-screen keyboard. */}
      {copyMatch && isPhone ? (
        <Sheet
          title={copyMatch.kind === "same_invoice"
            ? "You already sent this one"
            : "You already have this one in your drafts"}
          onClose={() => setCopyMatch(null)}
          variant="fullsheet"
          footer={
            <>
              <button type="button" className="kf-btn kf-btn--line" onClick={copyRemove}>
                Remove this one
              </button>
              <button type="button" className="kf-btn kf-btn--ghost" onClick={copyDifferent}>
                It is a different invoice
              </button>
              {copyMatch.kind === "same_invoice" && copyMatch.submission_id ? (
                <button type="button" className="kf-btn kf-btn--ghost" onClick={copyCreditFor}>
                  It is the credit for that invoice
                </button>
              ) : null}
            </>
          }
        >
          <p>
            {copyMatch.vendor_name ?? "The same vendor"}
            {copyMatch.invoice_number ? ` #${copyMatch.invoice_number}` : ""}
            {copyMatch.kind === "same_invoice" && copyMatch.invoice_date
              ? ` on ${fmtDate(copyMatch.invoice_date, "short")}` : ""}
            .
          </p>
        </Sheet>
      ) : null}

      {/* D2 phone page sheet */}
      {pagePhoneSheetOpen && activeFile ? (
        <Sheet
          title="The page"
          onClose={() => setPagePhoneSheetOpen(false)}
          variant="fullsheet"
        >
          <div className={`kf-inv-sitting__canvas${zoomed ? " is-zoom" : ""}`} tabIndex={0}>
            {activeFile.mime_type === "application/pdf" ? (
              viewUrls[activeFile.id] ? (
                <PdfPage url={viewUrls[activeFile.id]} rotation={activeFile.rotation} onExpired={handleViewExpired} />
              ) : (
                <p className="kf-inv-sitting__hint">Preparing the page...</p>
              )
            ) : (
              viewUrls[activeFile.id] ? (
                <img src={viewUrls[activeFile.id]} alt="Invoice page" style={{ transform: `rotate(${activeFile.rotation}deg)` }} onError={handleViewExpired} />
              ) : (
                <p className="kf-inv-sitting__hint">Preparing the page...</p>
              )
            )}
          </div>
          <p className="kf-inv-sitting__hint">To add, turn or remove pages, use a computer.</p>
        </Sheet>
      ) : null}
    </div>
  );
}

function PagerButton({
  to,
  siteSlug,
  asQAmp,
  label,
  icon,
}: {
  to: string | null;
  siteSlug: string;
  asQAmp: string;
  label: string;
  icon: React.ReactNode;
}) {
  if (!to) {
    return (
      <span className="kf-inv-sitting__nav__pager-btn is-off" aria-hidden>
        {icon}
      </span>
    );
  }
  return (
    <Link
      className="kf-inv-sitting__nav__pager-btn"
      href={`/invoices?site=${siteSlug}&draft=${to}${asQAmp}`}
      aria-label={label}
    >
      {icon}
    </Link>
  );
}
