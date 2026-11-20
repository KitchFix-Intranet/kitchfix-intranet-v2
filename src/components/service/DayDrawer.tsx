// The day form drawer.
//
// Shape: V2 drawer (opens by URL, Back closes it). Row 1 head, body
// is the service list + "Add a service" + Match/Not served/Undo/Clear,
// foot is totals + Save (the only filled button, the only writer).
//
// Save + clear + not-served + clash all talk to /api/service/day-actuals.

"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, X, Lock, Flag, House, Pencil, TriangleAlert, Ban, Undo2, Eraser, CheckCheck, Plus, Save, RefreshCw } from "lucide-react";
import { fmtCount } from "@/lib/fmt";
import type { DayDrawerView, DrawerService, SaveResult, TheirRow } from "@/lib/sc/dayActuals/types";
import { readDraft, writeDraft, clearDraft, isKept, markKept } from "./dayDraftStore";
import { NotesAndHistory } from "./drawer/NotesAndHistory";

type CountsMap = Record<string, number | null>;

type UndoStep = {
  label: string;
  counts: CountsMap;
  rowIds: string[];
};

interface Props {
  view: DayDrawerView;
  basePath: string;   // "/service"
  closeHref: string;  // the calendar URL (without ?day=)
  // When present, the drawer shows a "Saved <that day>. Now <this
  // day>." line under the head - set by the server page after it
  // reads ?moved=<dow>. Int 0..6 as the Monday-first index of the
  // day the operator just saved.
  movedFromDow: number | null;
}

const SIGN = "$";

// Monday-first dow names, matching the index the view carries.
const DOW_LONG_FULL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function DayDrawer({ view, basePath, closeHref, movedFromDow }: Props) {
  const router = useRouter();

  // ── initial state ──────────────────────────────────────────────

  const initialRows = useMemo(() => view.rows.map((r) => r.serviceId), [view.rows]);

  const initialCounts: CountsMap = useMemo(() => {
    const out: CountsMap = {};
    for (const r of view.rows) out[r.serviceId] = r.actualCount;
    return out;
  }, [view.rows]);

  // Hydrate from the device-local draft when present. A draft wins
  // only if it differs from the saved state; otherwise we read fresh.
  const [counts, setCounts] = useState<CountsMap>(initialCounts);
  const [rowIds, setRowIds] = useState<string[]>(initialRows);
  const [draftBanner, setDraftBanner] = useState<string | null>(null);

  useEffect(() => {
    const d = readDraft(view.site.accountKey, view.serviceDate);
    if (!d) return;
    // Different from saved? Keep the draft. Same? Drop the draft.
    const same =
      canonicalize(d.counts) === canonicalize(initialCounts) &&
      sortedEquals(d.addedServiceIds, []);
    if (same) {
      clearDraft(view.site.accountKey, view.serviceDate);
      return;
    }
    setCounts(d.counts);
    const added = d.addedServiceIds.filter((id) => !initialRows.includes(id));
    setRowIds([...initialRows, ...added]);
    setDraftBanner(`You had numbers here from ${timeAgo(d.at)} that were not saved.`);
  }, [view.site.accountKey, view.serviceDate, initialCounts, initialRows]);

  // Persist draft on every count change. Rule 17.
  useEffect(() => {
    const addedServiceIds = rowIds.filter((id) => !initialRows.includes(id));
    const same =
      canonicalize(counts) === canonicalize(initialCounts) &&
      sortedEquals(addedServiceIds, []);
    if (same) {
      clearDraft(view.site.accountKey, view.serviceDate);
    } else {
      writeDraft(view.site.accountKey, view.serviceDate, {
        counts,
        addedServiceIds,
        at: new Date().toISOString(),
      });
    }
  }, [counts, rowIds, initialCounts, initialRows, view.site.accountKey, view.serviceDate]);

  // ── undo stack + typing-batch marker ───────────────────────────

  const historyRef = useRef<UndoStep[]>([]);
  const typingServiceRef = useRef<string | null>(null);

  const pushUndo = useCallback((label: string) => {
    historyRef.current.push({ label, counts: { ...counts }, rowIds: [...rowIds] });
    if (historyRef.current.length > 40) historyRef.current.shift();
    typingServiceRef.current = null;
  }, [counts, rowIds]);

  const undo = useCallback(() => {
    const step = historyRef.current.pop();
    if (!step) return;
    setCounts(step.counts);
    setRowIds(step.rowIds);
    typingServiceRef.current = null;
  }, []);

  // ── action-level helpers ───────────────────────────────────────

  const canSave = useMemo(() => {
    const addedServiceIds = rowIds.filter((id) => !initialRows.includes(id));
    return (
      canonicalize(counts) !== canonicalize(initialCounts) ||
      !sortedEquals(addedServiceIds, [])
    );
  }, [counts, rowIds, initialCounts, initialRows]);

  const anyProjected = view.rows.some((r) => r.isProjected);
  const canMatch = useMemo(() => {
    return rowIds.some((id) => {
      const svc = view.services.find((s) => s.serviceId === id);
      if (!svc || !svc.isProjected) return false;
      const cur = counts[id];
      return cur === null || cur === undefined;
    });
  }, [rowIds, counts, view.services]);

  const allZero = useMemo(() => {
    if (!anyProjected) return false;
    for (const id of rowIds) {
      const svc = view.services.find((s) => s.serviceId === id);
      if (!svc || !svc.isProjected) continue;
      const cur = counts[id];
      if (cur === null || cur === undefined) return false;
      if (cur > 0) return false;
    }
    return true;
  }, [anyProjected, rowIds, counts, view.services]);

  // ── totals for the foot ─────────────────────────────────────────

  const totals = useMemo(() => computeTotals(view.services, counts, view.site.isBilled), [view.services, counts, view.site.isBilled]);

  // ── action handlers ─────────────────────────────────────────────

  const onInput = (id: string, raw: string) => {
    const cleaned = raw.replace(/[^0-9]/g, "").slice(0, 5);
    if (typingServiceRef.current !== id) {
      pushUndo("");
      typingServiceRef.current = id;
    }
    setCounts((c) => ({ ...c, [id]: cleaned === "" ? null : Number(cleaned) }));
  };

  const onFlat = (id: string, val: 0 | 1) => {
    pushUndo(`flat ${val ? "yes" : "no"}`);
    setCounts((c) => ({ ...c, [id]: val }));
  };

  const matchProjections = () => {
    pushUndo("match");
    setCounts((c) => {
      const next = { ...c };
      for (const id of rowIds) {
        const svc = view.services.find((s) => s.serviceId === id);
        if (!svc || !svc.isProjected) continue;
        if (next[id] === null || next[id] === undefined) next[id] = svc.projectedCount ?? 0;
      }
      return next;
    });
  };

  const markNotServed = () => {
    pushUndo("not served");
    setCounts(() => {
      const next: CountsMap = {};
      for (const id of rowIds) {
        const svc = view.services.find((s) => s.serviceId === id);
        if (!svc) continue;
        next[id] = svc.isProjected ? 0 : null;
      }
      return next;
    });
  };

  const clearBoxes = () => {
    pushUndo("clear");
    setCounts(() => {
      const next: CountsMap = {};
      for (const id of rowIds) next[id] = null;
      return next;
    });
  };

  const addService = (id: string) => {
    pushUndo("add");
    if (!rowIds.includes(id)) setRowIds([...rowIds, id]);
    setAdding(false);
  };

  // ── slipped-digit question (rule 16) ───────────────────────────

  const [slipAsk, setSlipAsk] = useState<{ serviceId: string; value: number; projection: number } | null>(null);

  const scanForSlippedDigit = useCallback((): { serviceId: string; value: number; projection: number } | null => {
    for (const id of rowIds) {
      const svc = view.services.find((s) => s.serviceId === id);
      if (!svc || svc.isFlatFee) continue;
      const v = counts[id];
      if (v === null || v === undefined) continue;
      const p = svc.projectedCount ?? 0;
      if (p <= 0) continue;
      if (v < 3 * p) continue;
      if (isKept(view.site.accountKey, view.serviceDate, id, v)) continue;
      return { serviceId: id, value: v, projection: p };
    }
    return null;
  }, [rowIds, counts, view.services, view.site.accountKey, view.serviceDate]);

  // ── clash state ────────────────────────────────────────────────

  const [clash, setClash] = useState<{ theirRows: TheirRow[]; dayToken: string } | null>(null);

  // ── save path ──────────────────────────────────────────────────

  const [busy, setBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const postSave = useCallback(async (opts: { acceptClash?: boolean } = {}) => {
    setBusy(true);
    setSaveErr(null);
    try {
      // Only touched entries: compare to initialCounts, send the
      // differences. Added rows with a non-null count are touched.
      const entries: { serviceId: string; actualCount: number }[] = [];
      for (const id of rowIds) {
        const now = counts[id];
        const was = initialCounts[id];
        if (now === null || now === undefined) continue; // blank is not a zero
        if (was === now) continue;
        entries.push({ serviceId: id, actualCount: now });
      }
      const body = {
        accountKey: view.site.accountKey,
        serviceDate: view.serviceDate,
        entries,
        dayToken: clash?.dayToken ?? view.dayToken,
        acceptClash: !!opts.acceptClash,
      };
      const res = await fetch(`${basePath === "/service" ? "/api/service" : basePath}/day-actuals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload: SaveResult = await res.json();
      if (!payload.ok) {
        if (payload.code === "DAY_CHANGED") {
          setClash({ theirRows: payload.theirRows, dayToken: payload.dayToken });
        } else {
          setSaveErr(("message" in payload && payload.message) ? payload.message : payload.code);
        }
        return;
      }
      // success - drop the draft. F2: if the week has another day
      // that still needs entry, advance there and pass the current
      // day's dow so the next drawer shows "Saved Tuesday. Now
      // Wednesday, Nov 18." Otherwise close back to the calendar.
      clearDraft(view.site.accountKey, view.serviceDate);
      const fromDow = ((new Date(`${view.serviceDate}T00:00:00Z`).getUTCDay() + 6) % 7);
      if (view.nextDayToEnterIso) {
        const sep = closeHref.includes("?") ? "&" : "?";
        const nextUrl = `${basePath}?site=${view.site.slug}${sep.startsWith("?") ? "" : ""}&day=${view.nextDayToEnterIso}&moved=${fromDow}`;
        // Reuse the period params already in closeHref.
        const periodMatch = closeHref.match(/[?&](fy=\d+&p=\d+)/);
        const periodQ = periodMatch ? `&${periodMatch[1]}` : "";
        const asMatch = closeHref.match(/[?&](as=[^&]+)/);
        const asQ = asMatch ? `&${asMatch[1]}` : "";
        router.replace(`${basePath}?site=${view.site.slug}${periodQ}${asQ}&day=${view.nextDayToEnterIso}&moved=${fromDow}`);
      } else {
        router.replace(closeHref);
      }
      router.refresh();
    } catch (e) {
      setSaveErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }, [rowIds, counts, initialCounts, view.site.accountKey, view.serviceDate, view.dayToken, clash, basePath, router, closeHref]);

  const onSave = useCallback(() => {
    // Rule 16: slipped-digit asks in place, once per unique value.
    const slip = scanForSlippedDigit();
    if (slip) { setSlipAsk(slip); return; }
    postSave();
  }, [scanForSlippedDigit, postSave]);

  const onClear = useCallback(async () => {
    setBusy(true);
    setSaveErr(null);
    try {
      const res = await fetch(`/api/service/day-actuals`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountKey: view.site.accountKey,
          serviceDate: view.serviceDate,
          dayToken: clash?.dayToken ?? view.dayToken,
          acceptClash: false,
        }),
      });
      const payload: SaveResult = await res.json();
      if (!payload.ok) {
        if (payload.code === "DAY_CHANGED") setClash({ theirRows: payload.theirRows, dayToken: payload.dayToken });
        else setSaveErr(("message" in payload && payload.message) ? payload.message : payload.code);
        return;
      }
      clearDraft(view.site.accountKey, view.serviceDate);
      router.replace(closeHref);
      router.refresh();
    } catch (e) {
      setSaveErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }, [view.site.accountKey, view.serviceDate, view.dayToken, clash, router, closeHref]);

  // ── keyboard: Esc closes ───────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") router.replace(closeHref);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, closeHref]);

  // ── render ─────────────────────────────────────────────────────

  const ro = view.lock !== null;

  const groupedRows: { group: string | null; rows: string[] }[] = useMemo(() => {
    const byGroup = new Map<string | null, string[]>();
    for (const id of rowIds) {
      const svc = view.services.find((s) => s.serviceId === id);
      const g = svc?.groupName ?? null;
      const arr = byGroup.get(g); if (arr) arr.push(id); else byGroup.set(g, [id]);
    }
    return Array.from(byGroup.entries()).map(([group, rows]) => ({ group, rows }));
  }, [rowIds, view.services]);

  const addableServices = useMemo(() => view.services.filter((s) => !rowIds.includes(s.serviceId)), [view.services, rowIds]);

  return (
    <div className="kf-sc-dr-overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) router.replace(closeHref); }}>
      <aside className="kf-sc-dr" role="dialog" aria-modal="true" aria-label={`${view.dayOfWeekLong} ${view.dayDisplayDate}`}>
        {/* Head */}
        <header className="kf-sc-dr__head">
          <div className="kf-sc-dr__who">
            <span className="kf-eyebrow kf-eyebrow--plain">{view.dayOfWeekLong}</span>
            <h3>{view.dayDisplayDate}</h3>
          </div>
          <div className="kf-sc-dr__nav">
            {view.prevIso ? (
              <Link className="kf-sc-dr__iconbtn" aria-label="Day before" href={`${basePath}?site=${view.site.slug}&day=${view.prevIso}`}><ChevronLeft size={20} strokeWidth={1.5} aria-hidden /></Link>
            ) : null}
            {view.nextIso ? (
              <Link className="kf-sc-dr__iconbtn" aria-label="Day after" href={`${basePath}?site=${view.site.slug}&day=${view.nextIso}`}><ChevronRight size={20} strokeWidth={1.5} aria-hidden /></Link>
            ) : null}
            <Link className="kf-sc-dr__iconbtn" aria-label="Close" href={closeHref}><X size={22} strokeWidth={1.5} aria-hidden /></Link>
          </div>
          <ul className="kf-sc-dr__chips" aria-label="Day state">
            <li className={`kf-sc-chip kf-sc-chip--${toneFor(view.state)}`}>{view.stateWord}</li>
            {view.phase ? <li className="kf-sc-chip kf-sc-chip--muted">{view.phase}</li> : null}
            {view.gameType ? (
              <li className="kf-sc-chip kf-sc-chip--info">
                <House size={14} strokeWidth={1.5} aria-hidden />
                <span>{view.gameType === "NIGHT" ? "Night game" : "Day game"}{view.gameTime ? ` · ${view.gameTime}` : ""}</span>
              </li>
            ) : null}
          </ul>
        </header>

        {/* Moved-from banner (F2 post-save focus). Shows "Saved
         * Tuesday. Now Wednesday, Nov 18." when the user just saved
         * a sibling day and we advanced here. Ephemeral - closing
         * the drawer or saving again drops the ?moved= param. */}
        {movedFromDow !== null ? (
          <div className="kf-sc-dr__moved" role="status">
            <Save size={16} strokeWidth={1.5} aria-hidden />
            <span>Saved {DOW_LONG_FULL[movedFromDow]}. Now <b>{view.dayOfWeekLong}, {view.dayDisplayDate}.</b></span>
          </div>
        ) : null}

        {/* Lock banner */}
        {view.lock ? (
          <div className="kf-sc-dr__lock" role="status">
            <Lock size={18} strokeWidth={1.5} aria-hidden />
            <span>{view.lock.message}</span>
          </div>
        ) : null}

        {/* Draft-from-this-device banner */}
        {!view.lock && draftBanner ? (
          <div className="kf-sc-dr__draft" role="status">
            <Pencil size={18} strokeWidth={1.5} aria-hidden />
            <span><b>{draftBanner}</b> They are back in the boxes.</span>
            <div className="kf-sc-dr__draftacts">
              <button type="button" className="kf-btn kf-btn--line" onClick={() => setDraftBanner(null)}>Keep them</button>
              <button type="button" className="kf-btn kf-btn--ghost" onClick={() => {
                setCounts(initialCounts); setRowIds(initialRows);
                clearDraft(view.site.accountKey, view.serviceDate);
                setDraftBanner(null);
              }}>Clear them</button>
            </div>
          </div>
        ) : null}

        {/* Body */}
        <div className="kf-sc-dr__body">
          {groupedRows.length === 0 ? (
            <p className="kf-sc-dr__empty"><Flag size={18} aria-hidden /> Nothing is on the projections for this day.</p>
          ) : groupedRows.map(({ group, rows }) => (
            <section key={group ?? "__none"} className="kf-sc-dr__group">
              {group ? <h4 className="kf-sc-dr__groupname">{group}</h4> : null}
              <ul className="kf-sc-dr__rows">
                {rows.map((id) => {
                  const svc = view.services.find((s) => s.serviceId === id);
                  if (!svc) return null;
                  return <ServiceRow key={id} svc={svc} value={counts[id]} readOnly={ro} isBilled={view.site.isBilled} onInput={onInput} onFlat={onFlat} />;
                })}
              </ul>
            </section>
          ))}

          {!ro ? (
            <div className="kf-sc-dr__add">
              {addableServices.length > 0 ? (
                <>
                  <button type="button" className="kf-sc-dr__addtoggle" aria-expanded={adding} onClick={() => setAdding((v) => !v)}>
                    <Plus size={18} strokeWidth={1.5} aria-hidden />
                    <span><b>Add a service</b><small>Served something that was not projected</small></span>
                  </button>
                  {adding ? (
                    <ul className="kf-sc-dr__addlist">
                      {addableServices.map((s) => (
                        <li key={s.serviceId}>
                          <button type="button" onClick={() => addService(s.serviceId)}>
                            <Plus size={16} strokeWidth={1.5} aria-hidden />
                            <span>{s.serviceName}{!s.hasInvoiceSlot && !s.isNonRevenue ? " · No invoice line yet" : ""}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}

          {/* Action buttons (outlined) */}
          {!ro && rowIds.length > 0 ? (
            <div className="kf-sc-dr__acts">
              {anyProjected ? (
                <>
                  <button type="button" className="kf-btn kf-btn--line" onClick={matchProjections} disabled={!canMatch}>
                    <CheckCheck size={18} strokeWidth={1.5} aria-hidden /> Match projections
                  </button>
                  <button type="button" className="kf-btn kf-btn--line" onClick={markNotServed} disabled={allZero}>
                    <Ban size={18} strokeWidth={1.5} aria-hidden /> Not served this day
                  </button>
                </>
              ) : null}
              <button type="button" className="kf-btn kf-btn--line" onClick={undo} disabled={historyRef.current.length === 0}>
                <Undo2 size={18} strokeWidth={1.5} aria-hidden /> Undo{historyRef.current.length ? (historyRef.current[historyRef.current.length - 1].label ? ` ${historyRef.current[historyRef.current.length - 1].label}` : "") : ""}
              </button>
              <button type="button" className="kf-btn kf-btn--line" onClick={clearBoxes} disabled={!canSave}>
                <Eraser size={18} strokeWidth={1.5} aria-hidden /> Clear the boxes
              </button>
              {/* Clear-to-projections (DELETE path) renders only when
                  there are already saved actuals to remove. */}
              {view.rows.some((r) => r.hasActualsRow) ? (
                <button type="button" className="kf-btn kf-btn--line" onClick={onClear} disabled={busy}>
                  <Eraser size={18} strokeWidth={1.5} aria-hidden /> Back to projections
                </button>
              ) : null}
            </div>
          ) : null}

          <NotesAndHistory
            accountKey={view.site.accountKey}
            serviceDate={view.serviceDate}
            timezone={view.site.timezone}
            readOnly={ro}
          />
        </div>

        {/* Foot */}
        <footer className="kf-sc-dr__foot">
          {clash ? (
            <ClashPanel theirRows={clash.theirRows} services={view.services} onKeepTheirs={() => router.refresh()} onSaveMine={() => postSave({ acceptClash: true })} busy={busy} />
          ) : slipAsk ? (
            <SlipPanel ask={slipAsk} services={view.services} onKeep={() => {
              markKept(view.site.accountKey, view.serviceDate, slipAsk.serviceId, slipAsk.value);
              setSlipAsk(null);
              postSave();
            }} onChange={() => {
              // let the user edit; focus the input
              setSlipAsk(null);
              const el = document.getElementById(`in-${slipAsk.serviceId}`) as HTMLInputElement | null;
              if (el) { el.focus(); el.select(); }
            }} />
          ) : (
            <div className="kf-sc-dr__totals">
              <b>{fmtCount(totals.meals)}</b>
              <span>
                {totals.meals === 1 ? "meal" : "meals"}
                {view.site.isBilled && totals.cents > 0 ? ` · ${SIGN}${(totals.cents / 100).toFixed(2)} before tax` : ""}
              </span>
            </div>
          )}
          {!clash && !slipAsk ? (
            <button type="button" className={`kf-btn kf-btn--primary${busy ? " is-busy" : ""}`} onClick={onSave} disabled={!canSave || busy || ro}>
              {busy ? <RefreshCw size={18} strokeWidth={1.5} aria-hidden /> : <Save size={18} strokeWidth={1.5} aria-hidden />}
              <span>{busy ? "Saving" : (allZero ? "Save as not served" : "Save")}</span>
            </button>
          ) : null}
          {saveErr ? (
            <p className="kf-sc-dr__err" role="alert">
              <TriangleAlert size={18} strokeWidth={1.5} aria-hidden /> {saveErr}
            </p>
          ) : null}
        </footer>
      </aside>
    </div>
  );
}

// ── one service row ───────────────────────────────────────────────

function ServiceRow({
  svc, value, readOnly, isBilled, onInput, onFlat,
}: {
  svc: DrawerService;
  value: number | null | undefined;
  readOnly: boolean;
  isBilled: boolean;
  onInput: (id: string, raw: string) => void;
  onFlat: (id: string, val: 0 | 1) => void;
}) {
  const unitWord = svc.isFlatFee ? "a week" : svc.unit;
  const price = svc.isNonRevenue
    ? "Not billed"
    : (svc.priceCents == null ? "" : `${SIGN}${(svc.priceCents / 100).toFixed(2)} ${unitWord}`);
  const subBits: string[] = [];
  if (isBilled && price) subBits.push(price);
  if (svc.isFlatFee) subBits.push("Weekly charge");
  if (!svc.isProjected && !readOnly) subBits.push("Added, not on the projections");
  const sub = subBits.join(" · ");

  if (readOnly) {
    const display = value == null ? "-" : (svc.isFlatFee ? (value ? "Yes" : "No") : fmtCount(value));
    return (
      <li className="kf-sc-dr__row">
        <span className="kf-sc-dr__name"><b>{svc.serviceName}</b>{sub ? <small>{sub}</small> : null}</span>
        <span className={`kf-sc-dr__val${value == null ? " is-ghost" : ""}`}>{display}</span>
        <span className="kf-sc-dr__unit">{unitWord}</span>
      </li>
    );
  }
  if (svc.isFlatFee) {
    return (
      <li className="kf-sc-dr__row">
        <span className="kf-sc-dr__name" id={`lb-${svc.serviceId}`}><b>{svc.serviceName}</b>{sub ? <small>{sub}</small> : null}</span>
        <span className="kf-sc-dr__yn" role="radiogroup" aria-labelledby={`lb-${svc.serviceId}`}>
          <button type="button" role="radio" aria-checked={value === 1} onClick={() => onFlat(svc.serviceId, 1)}>Yes</button>
          <button type="button" role="radio" aria-checked={value === 0} onClick={() => onFlat(svc.serviceId, 0)}>No</button>
        </span>
        <span className="kf-sc-dr__unit">{unitWord}</span>
      </li>
    );
  }
  const val = value == null ? "" : String(value);
  return (
    <li className="kf-sc-dr__row">
      <label className="kf-sc-dr__name" htmlFor={`in-${svc.serviceId}`}><b>{svc.serviceName}</b>{sub ? <small>{sub}</small> : null}</label>
      <input
        className={`kf-sc-dr__input${val === "" ? "" : " is-set"}`}
        id={`in-${svc.serviceId}`}
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={5}
        autoComplete="off"
        enterKeyHint="next"
        value={val}
        placeholder={svc.projectedCount != null ? String(svc.projectedCount) : ""}
        onChange={(e) => onInput(svc.serviceId, e.target.value)}
      />
      <span className="kf-sc-dr__unit">{unitWord}</span>
    </li>
  );
}

// ── slipped-digit panel ──────────────────────────────────────────

function SlipPanel({ ask, services, onKeep, onChange }: {
  ask: { serviceId: string; value: number; projection: number };
  services: DrawerService[];
  onKeep: () => void;
  onChange: () => void;
}) {
  const svc = services.find((s) => s.serviceId === ask.serviceId);
  return (
    <div className="kf-sc-dr__ask" role="alertdialog">
      <p><b>{svc?.serviceName ?? "This service"} is {fmtCount(ask.value)}.</b> The projection was {fmtCount(ask.projection)}. Keep {fmtCount(ask.value)}?</p>
      <div className="kf-sc-dr__askacts">
        <button type="button" className="kf-btn kf-btn--line" onClick={onKeep}>Keep {fmtCount(ask.value)}</button>
        <button type="button" className="kf-btn kf-btn--primary" onClick={onChange}>Change it</button>
      </div>
    </div>
  );
}

// ── clash panel ──────────────────────────────────────────────────

function ClashPanel({ theirRows, services, onKeepTheirs, onSaveMine, busy }: {
  theirRows: TheirRow[];
  services: DrawerService[];
  onKeepTheirs: () => void;
  onSaveMine: () => void;
  busy: boolean;
}) {
  return (
    <div className="kf-sc-dr__clash" role="alertdialog">
      <p><b>Someone else saved this day while you had it open.</b> Nothing was written over.</p>
      <ul>
        {theirRows.map((r) => (
          <li key={r.serviceId}>
            <span>{r.serviceName || services.find((s) => s.serviceId === r.serviceId)?.serviceName || r.serviceId}</span>
            <span>Theirs <b>{fmtCount(r.actualCount)}</b></span>
          </li>
        ))}
      </ul>
      <div className="kf-sc-dr__askacts">
        <button type="button" className="kf-btn kf-btn--line" onClick={onKeepTheirs} disabled={busy}>Keep theirs</button>
        <button type="button" className="kf-btn kf-btn--primary" onClick={onSaveMine} disabled={busy}>Save mine</button>
      </div>
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────

function toneFor(state: string): string {
  switch (state) {
    case "submitted": return "good";
    case "closed":    return "muted";
    case "entered":
    case "part_entered":
    case "not_served": return "info";
    case "no_actuals": return "muted";
    case "needs_actuals":
    case "needs_fix":  return "warn";
    case "projected":  return "muted";
    case "no_service": return "muted";
    default: return "muted";
  }
}

function canonicalize(c: CountsMap): string {
  const keys = Object.keys(c).sort();
  return keys.filter((k) => c[k] !== null && c[k] !== undefined).map((k) => `${k}:${c[k]}`).join("|");
}

function sortedEquals(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort(), sb = [...b].sort();
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}

function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

function computeTotals(services: DrawerService[], counts: CountsMap, isBilled: boolean) {
  let meals = 0;
  let cents = 0;
  for (const id of Object.keys(counts)) {
    const v = counts[id];
    if (v === null || v === undefined) continue;
    const svc = services.find((s) => s.serviceId === id);
    if (!svc) continue;
    if (svc.unit === "meals" && !svc.isFlatFee) meals += v;
    if (isBilled && !svc.isNonRevenue && svc.priceCents != null) cents += svc.priceCents * v;
  }
  return { meals, cents };
}
