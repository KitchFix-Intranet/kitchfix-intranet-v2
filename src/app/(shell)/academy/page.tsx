// /academy - To do. Server component. Renders the viewer's open
// requirements as a one-column sheet inside the shared shell, from
// loadRoom(email). States: first-visit welcome (dismissed client-side),
// past-due band, resting (nothing to do, next cycle exists), the
// read-failed band path, All-set celebration (train C), and the
// normal "N things to do" state.
//
// All-set signal (closes the train B deferral): when the Reader
// completes the last open requirement it redirects to
// /academy?signed=<requirementId>. If the param is present AND the
// queue is now empty, we render the celebration card once; a plain
// visit with an empty queue renders the resting band. This is a
// transient URL signal, not a persisted flag.

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { requireAppAccess } from "@/lib/gate";
import { loadRoom } from "@/lib/academy/room";
import type { QueueItem } from "@/lib/academy/room";
import { IdentBand } from "@/components/ui/IdentBand";
import { FirstVisitCard } from "@/components/academy/FirstVisitCard";
import { fmtDate } from "@/lib/fmt";
import "@/components/academy/academy.css";

// Numbers one-nine spelled; 10+ use digits. The render V6 title + kick
// both use words for small counts ("Four things to do, Kevin"); using
// digits for everything would read mechanically.
const WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
function word(n: number): string {
  if (n < 0) return String(n);
  if (n < WORDS.length) return WORDS[n];
  return String(n);
}
function wordLower(n: number): string {
  return word(n).toLowerCase();
}

function firstName(displayName: string | null): string | null {
  const trimmed = (displayName ?? "").trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0] || null;
}

function minutesPhrase(mins: number): string {
  if (mins <= 0) return "a few minutes";
  if (mins < 60) return `About ${mins} minutes`;
  const hours = Math.round(mins / 60);
  return hours === 1 ? "About 1 hour" : `About ${hours} hours`;
}

function duePhrase(iso: string | null): string {
  if (!iso) return "No deadline";
  return `Due ${fmtDate(iso, "short")}`;
}

function pluralDocs(n: number): string {
  return n === 1 ? "document" : "documents";
}

// "Up next" is the first unsigned, non-locked item. A later part is
// locked when any predecessor part on the SAME doc_id (same cycle,
// lower obligation_key order) is unsigned. The queue is pre-sorted by
// the loader; the predecessor map is built from the queue itself.
function buildLockMap(queue: QueueItem[]): Map<string | number, QueueItem> {
  // For each item, find the first unsigned predecessor on the same doc
  // whose part_number is lower, if any. The loader groups the parts and
  // orders them; we scan each doc_id's items in order.
  const byDoc = new Map<string, QueueItem[]>();
  for (const q of queue) {
    const list = byDoc.get(q.doc_id) ?? [];
    list.push(q);
    byDoc.set(q.doc_id, list);
  }
  const lockedBy = new Map<string | number, QueueItem>();
  for (const [, list] of byDoc) {
    // list is already in queue order; iterate and record the latest
    // unsigned seen as the predecessor of every later item.
    let lastUnsigned: QueueItem | null = null;
    for (const item of list) {
      if (lastUnsigned && !item.signed) {
        lockedBy.set(item.requirement_id, lastUnsigned);
      }
      if (!item.signed && lastUnsigned === null) {
        lastUnsigned = item;
      }
    }
  }
  return lockedBy;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

type PageProps = {
  searchParams: Promise<{ signed?: string | string[] }>;
};

export default async function Page({ searchParams }: PageProps) {
  const { email } = await requireAppAccess("/academy");
  const sp = await searchParams;
  const justSigned = Array.isArray(sp.signed) ? sp.signed[0] : sp.signed;
  const result = await loadRoom(email);

  if (!result.ok) {
    return (
      <div className="kf-sheet">
        <IdentBand
          eyebrow="Academy"
          title="Status unavailable"
          kick="Couldn't read your list."
          status="failed"
          pageName="To do"
        />
      </div>
    );
  }

  const { viewer, queue, queueSummary } = result;
  const name = firstName(viewer.displayName);
  const remaining = queueSummary.remainingCount;
  const totalMinutesRemaining = queueSummary.totalMinutesRemaining;

  // First unsigned (actionable) item - carries the "Up next" pill and is
  // the Continue CTA target.
  const firstUnsigned = queue.find((q) => !q.signed) ?? null;

  // Earliest due date among unsigned items.
  const earliestDueISO = queue
    .filter((q) => !q.signed && q.due_date)
    .map((q) => q.due_date as string)
    .sort((a, b) => a.localeCompare(b))[0] ?? null;

  // All overdue: every unsigned item has a due_date, and all < today.
  const today = todayISO();
  const unsigned = queue.filter((q) => !q.signed);
  const allOverdue =
    unsigned.length > 0 &&
    unsigned.every((q) => q.due_date != null && q.due_date < today);

  const lockedBy = buildLockMap(queue);

  const continueHref = firstUnsigned
    ? `/academy/read/${firstUnsigned.requirement_id}`
    : null;

  // ─── Resting state (remaining = 0). With a transient ?signed=<id>
  // param (set by the Reader when the final sign succeeds), show
  // the one celebration card instead of the plain resting band.
  // The signal is in the URL and gone on the next plain load - no
  // persisted flag, per R-AC7/R-AC11.
  if (remaining === 0) {
    const nextCycleLine = result.nextCycle
      ? `The next one shows up here when it is published.`
      : `No next cycle is published yet.`;
    const title = name ? `Nothing to do, ${name}` : "Nothing to do";
    if (justSigned) {
      const celebrationTitle = name ? `That is everything, ${name}` : "That is everything";
      return (
        <div className="kf-sheet">
          <IdentBand
            eyebrow="Academy"
            title={celebrationTitle}
            kick="Nothing waiting. Your record is permanent."
            cta={{ label: `Done (${viewer.record.signedAllTime})`, href: "/academy/done" }}
          />
          <IdentLine displayName={viewer.displayName} />
          <PhoneStatus title={celebrationTitle} />
          <AllSetCard
            signedAllTime={viewer.record.signedAllTime}
            nextCycle={result.nextCycle}
          />
          <Footer />
        </div>
      );
    }
    return (
      <div className="kf-sheet">
        <IdentBand
          eyebrow="Academy"
          title={title}
          kick={`You are all set. ${nextCycleLine}`.slice(0, 60)}
          cta={{ label: `Done (${viewer.record.signedAllTime})`, href: "/academy/done" }}
        />
        <IdentLine displayName={viewer.displayName} />
        <PhoneStatus title={title} />
        <RestingCard nextCycle={result.nextCycle} />
        <Footer />
      </div>
    );
  }

  // ─── Past-due band. "Two things were due Nov 30, Kevin / They are
  // still here. About 22 minutes, whenever you can." No red, no
  // countdown (R-AC19).
  const overduePhrase = allOverdue && earliestDueISO
    ? `${word(remaining)} things were due ${fmtDate(earliestDueISO, "short")}${name ? `, ${name}` : ""}`
    : null;

  const normalTitle = name
    ? `${word(remaining)} things to do, ${name}`
    : `${word(remaining)} things to do`;
  const bandTitle = overduePhrase ?? normalTitle;

  const bandKick = allOverdue
    ? `They are still here. ${minutesPhrase(totalMinutesRemaining)}, whenever you can.`
    : `Read and sign ${wordLower(remaining)} ${pluralDocs(remaining)}. ${minutesPhrase(totalMinutesRemaining)}. ${duePhrase(earliestDueISO)}.`;
  const bandKickCapped = bandKick.length > 60 ? bandKick.slice(0, 60) : bandKick;

  return (
    <div className="kf-sheet">
      <IdentBand
        eyebrow="Academy"
        title={bandTitle}
        kick={bandKickCapped}
        cta={continueHref ? { label: "Continue", href: continueHref } : undefined}
      />
      <IdentLine displayName={viewer.displayName} />
      <PhoneStatus title={bandTitle} />
      {viewer.record.firstRun ? (
        <FirstVisitCard displayName={viewer.displayName} />
      ) : null}
      <ul className="kf-todo-list" aria-label="To do">
        {queue.map((q) => {
          const locked = lockedBy.get(q.requirement_id) ?? null;
          const isUpNext = firstUnsigned?.requirement_id === q.requirement_id;
          return (
            <TodoRow
              key={String(q.requirement_id)}
              item={q}
              locked={locked}
              isUpNext={isUpNext}
            />
          );
        })}
      </ul>
      <p className="kf-sheet-footer">
        Your place in a document is saved. Nothing is recorded until you sign.
      </p>
    </div>
  );
}

function IdentLine({ displayName }: { displayName: string | null }) {
  const nameFull = (displayName ?? "").trim() || "You";
  return (
    <p className="kf-ident-line" aria-label="Account">
      <span className="kf-ident-line__who">{nameFull}</span>
      <span className="kf-ident-line__sep" aria-hidden>-</span>
      <span>Not you?</span>
      <a href="/api/auth/signout" className="kf-ident-line__switch">
        Switch
      </a>
    </p>
  );
}

function PhoneStatus({ title }: { title: string }) {
  return (
    <p className="kf-pstatus" aria-label="Status">
      {title}
    </p>
  );
}

function partShortTitle(sourceSection: string | null | undefined): string {
  const src = String(sourceSection || "").trim();
  if (!src) return "";
  const first = src.split(/;/, 1)[0].trim();
  if (!first) return "";
  const MAX = 40;
  if (first.length <= MAX) return first;
  const cut = first.slice(0, MAX);
  const lastSp = cut.lastIndexOf(" ");
  return (lastSp > 20 ? cut.slice(0, lastSp) : cut).replace(/[\s,.·-]+$/, "") + "…";
}

function TodoRow({
  item,
  locked,
  isUpNext,
}: {
  item: QueueItem;
  locked: QueueItem | null;
  isUpNext: boolean;
}) {
  const title = item.doc_title;
  const subParts: string[] = [];
  // Multi-part docs: lead with the module label (same string Done
  // uses). Lets a reader tell "Part 1: Origin" from "Part 2:
  // Standard" at a glance instead of two identical rows. Section-7
  // fix.
  if (item.total_parts > 1) {
    const module = partShortTitle(item.source_section);
    if (module) subParts.push(`Part ${item.part_number} of ${item.total_parts} - ${module}`);
    else subParts.push(`Part ${item.part_number} of ${item.total_parts}`);
  } else if (item.card_line) {
    subParts.push(item.card_line);
  }
  if (item.est_minutes > 0) subParts.push(`${item.est_minutes} min`);
  const sub = subParts.join(" - ");

  if (item.signed) {
    // Signed items in the queue (if the loader returns any) link to the
    // Done ledger, not the reader.
    return (
      <li>
        <Link
          href="/academy/done"
          className="kf-todo-row kf-todo-row--signed"
          aria-label={`${title}, signed`}
        >
          <div className="kf-todo-row__text">
            <span className="kf-todo-row__title">{title}</span>
            <span className="kf-todo-row__sub">
              {item.certificate_serial ? `Certificate ${item.certificate_serial}` : "Signed"}
            </span>
          </div>
          <span className="kf-todo-row__chev" aria-hidden>
            <ChevronRight size={20} strokeWidth={1.5} />
          </span>
        </Link>
      </li>
    );
  }

  if (locked) {
    const predecessorLabel =
      locked.total_parts > 1 ? `After Part ${locked.part_number}` : `After ${locked.doc_title}`;
    return (
      <li>
        <div
          className="kf-todo-row kf-todo-row--locked"
          aria-label={`${title}, locked until the earlier part is signed`}
          aria-disabled="true"
        >
          <div className="kf-todo-row__text">
            <span className="kf-todo-row__title">{title}</span>
            <span className="kf-todo-row__sub">{sub || "Reading"}</span>
            <span className="kf-todo-row__flags">
              <span className="kf-pill kf-pill--muted">{predecessorLabel}</span>
            </span>
          </div>
          <span className="kf-todo-row__chev" aria-hidden>
            <ChevronRight size={20} strokeWidth={1.5} />
          </span>
        </div>
      </li>
    );
  }

  // Actionable row.
  return (
    <li>
      <Link
        href={`/academy/read/${item.requirement_id}`}
        className="kf-todo-row"
        aria-label={title}
      >
        <div className="kf-todo-row__text">
          <span className="kf-todo-row__title">{title}</span>
          <span className="kf-todo-row__sub">{sub || "Reading"}</span>
          {isUpNext ? (
            <span className="kf-todo-row__flags">
              <span className="kf-pill kf-pill--up-next">Up next</span>
            </span>
          ) : null}
        </div>
        <span className="kf-todo-row__chev" aria-hidden>
          <ChevronRight size={20} strokeWidth={1.5} />
        </span>
      </Link>
    </li>
  );
}

function AllSetCard({
  signedAllTime,
  nextCycle,
}: {
  signedAllTime: number;
  nextCycle: { label: string; period_start: string } | null;
}) {
  const body = nextCycle
    ? `${signedAllTime} signature${signedAllTime === 1 ? "" : "s"} on record. Next cycle: ${nextCycle.label}.`
    : `${signedAllTime} signature${signedAllTime === 1 ? "" : "s"} on record. Nothing is scheduled yet.`;
  return (
    <section className="kf-allset" aria-label="All set">
      <span className="kf-allset__eyebrow">All set</span>
      <h2 className="kf-allset__title">That is everything</h2>
      <p className="kf-allset__body">{body}</p>
      <Link href="/academy/done" className="kf-btn kf-btn--primary">
        <span>See your record</span>
      </Link>
    </section>
  );
}

function RestingCard({ nextCycle }: { nextCycle: { label: string; period_start: string } | null }) {
  const kick = nextCycle
    ? `Next cycle: ${nextCycle.label}. Starts ${fmtDate(nextCycle.period_start, "short")}.`
    : "Nothing is scheduled yet.";
  return (
    <section className="kf-state" aria-label="At rest">
      <p className="kf-state__title">You are current</p>
      <p className="kf-state__body">{kick}</p>
    </section>
  );
}

function Footer() {
  return (
    <p className="kf-sheet-footer">
      Your record is permanent. Nothing is recorded until you sign.
    </p>
  );
}
