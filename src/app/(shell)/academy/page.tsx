// /academy - To do. V7 structure. Server component.
//
// Band stretches the full canvas (R-AC25) and carries a facts strip:
// "About <mins> min" / "Due <date>" / "Signed <count>". The headline
// count is the row count (never disagrees with the list - law 14).
//
// Below the band, a two-column frame: a primary column with the
// hero "pick up where you left off" card and the remaining-rows
// section, and a record rail with the viewer's certificates + a
// "How this works" card. At <=1180 the rail stacks under the primary
// (R-AC25 - it carries content, so it may not be hidden).
//
// Signed items leave the main list (review P1 #1); if there are any,
// a quiet "<N> signed - See Done" line sits under it.
//
// All-set signal: when the Reader completes the last open requirement
// it redirects to /academy?signed=<requirementId>. If the queue is
// empty on load with the param, we render the single celebration card.

import Link from "next/link";
import { ChevronRight, Download } from "lucide-react";
import { requireAppAccess } from "@/lib/gate";
import { loadRoom } from "@/lib/academy/room";
import { loadRecords } from "@/lib/academy/records";
import type { QueueItem } from "@/lib/academy/room";
import { AcademyBand } from "@/components/academy/AcademyBand";
import { FirstVisitCard } from "@/components/academy/FirstVisitCard";
import { fmtDate } from "@/lib/fmt";
import "@/components/academy/academy.css";

// Number copy helpers.
const WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
function word(n: number): string {
  if (n < 0) return String(n);
  if (n < WORDS.length) return WORDS[n];
  return String(n);
}
function wordLower(n: number): string { return word(n).toLowerCase(); }
function firstName(displayName: string | null): string | null {
  const trimmed = (displayName ?? "").trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0] || null;
}
function pluralDocs(n: number): string { return n === 1 ? "document" : "documents"; }

function todayISO(): string { return new Date().toISOString().slice(0, 10); }

// "Up next" is the first unsigned, non-locked item.
function buildLockMap(queue: QueueItem[]): Map<string | number, QueueItem> {
  const byDoc = new Map<string, QueueItem[]>();
  for (const q of queue) {
    const list = byDoc.get(q.doc_id) ?? [];
    list.push(q);
    byDoc.set(q.doc_id, list);
  }
  const lockedBy = new Map<string | number, QueueItem>();
  for (const [, list] of byDoc) {
    let lastUnsigned: QueueItem | null = null;
    for (const item of list) {
      if (lastUnsigned && !item.signed) lockedBy.set(item.requirement_id, lastUnsigned);
      if (!item.signed && lastUnsigned === null) lastUnsigned = item;
    }
  }
  return lockedBy;
}

type PageProps = {
  searchParams: Promise<{ signed?: string | string[] }>;
};

export default async function Page({ searchParams }: PageProps) {
  const { email } = await requireAppAccess("/academy");
  const sp = await searchParams;
  const justSigned = Array.isArray(sp.signed) ? sp.signed[0] : sp.signed;
  // loadRoom owns the queue + remaining count; loadRecords provides the
  // viewer's certificates for the right rail. Running them in parallel
  // keeps the page's first byte on the same budget as before.
  const [roomRes, recordsRes] = await Promise.all([
    loadRoom(email),
    loadRecords(email),
  ]);

  if (!roomRes.ok) {
    return (
      <div className="kf-academy">
        <AcademyBand
          eyebrow="Academy"
          title="Status unavailable"
          kick="Couldn't read your list."
        />
      </div>
    );
  }

  const { viewer, queue, queueSummary } = roomRes;
  const name = firstName(viewer.displayName);
  const remaining = queueSummary.remainingCount;
  const totalMinutesRemaining = queueSummary.totalMinutesRemaining;
  const signedCount = viewer.record.signedAllTime;

  // Unsigned-only roster for the main list (signed items leave the
  // list per P1 #1). Lock map built from the full queue because the
  // dependency relationships still apply even after a part signs.
  const unsignedQueue = queue.filter((q) => !q.signed);
  const firstUnsigned = unsignedQueue[0] ?? null;

  const earliestDueISO = unsignedQueue
    .filter((q) => q.due_date)
    .map((q) => q.due_date as string)
    .sort((a, b) => a.localeCompare(b))[0] ?? null;

  const today = todayISO();
  const allOverdue =
    unsignedQueue.length > 0 &&
    unsignedQueue.every((q) => q.due_date != null && q.due_date < today);

  const lockedBy = buildLockMap(queue);
  const continueHref = firstUnsigned
    ? `/academy/read/${firstUnsigned.requirement_id}`
    : null;

  // ─── Resting state (remaining = 0).
  if (remaining === 0) {
    const nextCycleLine = roomRes.nextCycle
      ? `The next one shows up here when it is published.`
      : `No next cycle is published yet.`;
    const title = name ? `Nothing to do, ${name}` : "Nothing to do";
    if (justSigned) {
      // The All-set celebration (its own full page: single centred
      // column with a stretched no-facts band and three big numbers).
      return <AllSetPage viewer={viewer} recordsRes={recordsRes} />;
    }
    return (
      <div className="kf-academy">
        <div className="kf-academy__wash" aria-hidden />
        <AcademyBand
          eyebrow="Academy"
          title={title}
          kick={`You are all set. ${nextCycleLine}`.slice(0, 60)}
          cta={{ label: `Done (${signedCount})`, href: "/academy/done" }}
        />
        <div className="kf-academy__frame">
          <div className="kf-academy__main">
            <IdentLine displayName={viewer.displayName} />
            <PhoneStatus title={title} />
            <RestingCard nextCycle={roomRes.nextCycle} />
          </div>
          <aside className="kf-academy__rail" aria-label="Your record">
            <RecordRail recordsRes={recordsRes} />
            <HowThisWorksCard />
          </aside>
        </div>
        <Footer />
      </div>
    );
  }

  // ─── Normal state: band + hero + rows + rail.
  const overduePhrase = allOverdue && earliestDueISO
    ? `${word(remaining)} things were due ${fmtDate(earliestDueISO, "short")}${name ? `, ${name}` : ""}`
    : null;
  const normalTitle = name
    ? `${word(remaining)} things to do, ${name}`
    : `${word(remaining)} things to do`;
  const bandTitle = overduePhrase ?? normalTitle;
  const bandKick = allOverdue
    ? `They are still here. Read it, answer the checks, type your name to sign.`
    : `Read it, answer a couple of questions, type your name to sign.`;
  const bandKickCapped = bandKick.length > 60 ? bandKick.slice(0, 60) : bandKick;

  // After-rows "then" rows exclude the hero's row.
  const thenRows = firstUnsigned
    ? unsignedQueue.filter((q) => q.requirement_id !== firstUnsigned.requirement_id)
    : unsignedQueue;

  return (
    <div className="kf-academy">
      <div className="kf-academy__wash" aria-hidden />
      <AcademyBand
        eyebrow="Academy"
        title={bandTitle}
        kick={bandKickCapped}
        facts={[
          { label: "About", value: totalMinutesRemaining, unit: "min" },
          { label: "Due", value: earliestDueISO ? fmtDate(earliestDueISO, "short") : "-" },
          { label: "Signed", value: signedCount },
        ]}
        cta={continueHref ? { label: "Continue", href: continueHref } : undefined}
      />
      <div className="kf-academy__frame">
        <div className="kf-academy__main">
          <IdentLine displayName={viewer.displayName} />
          <PhoneStatus title={bandTitle} />
          {viewer.record.firstRun ? (
            <FirstVisitCard displayName={viewer.displayName} />
          ) : null}
          {firstUnsigned ? <HeroCard item={firstUnsigned} /> : null}
          {thenRows.length > 0 ? (
            <section aria-label="Then">
              <header className="kf-then-head">
                <span className="kf-then-head__title">Then</span>
                <span className="kf-then-head__hint">
                  {thenRows.length} more {pluralDocs(thenRows.length)}
                </span>
              </header>
              <ul className="kf-todo-list" style={{ marginTop: "var(--sp-sp-3)" }}>
                {thenRows.map((q) => {
                  const locked = lockedBy.get(q.requirement_id) ?? null;
                  return (
                    <TodoRow
                      key={String(q.requirement_id)}
                      item={q}
                      locked={locked}
                      isUpNext={false}
                    />
                  );
                })}
              </ul>
            </section>
          ) : null}
          {signedCount > 0 ? (
            <p className="kf-signed-below">
              {signedCount} signed - <Link href="/academy/done">See Done</Link>
            </p>
          ) : null}
        </div>
        <aside className="kf-academy__rail" aria-label="Your record">
          <RecordRail recordsRes={recordsRes} />
          <HowThisWorksCard />
        </aside>
      </div>
      <Footer />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function IdentLine({ displayName }: { displayName: string | null }) {
  const nameFull = (displayName ?? "").trim() || "You";
  return (
    <p className="kf-ident-line" aria-label="Account">
      <span className="kf-ident-line__who">{nameFull}</span>
      <span className="kf-ident-line__sep" aria-hidden>-</span>
      <span>Not you?</span>
      <a href="/api/auth/signout" className="kf-ident-line__switch">Switch</a>
    </p>
  );
}

function PhoneStatus({ title }: { title: string }) {
  return <p className="kf-pstatus" aria-label="Status">{title}</p>;
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

/* ------------------------------------------------------------------ */

function HeroCard({ item }: { item: QueueItem }) {
  const minutes = item.est_minutes > 0 ? item.est_minutes : 0;
  // Iteration-1 item 2: drive the hero from loadRoom's `started`
  // signal (academy_module_progress.sections_seen non-empty OR
  // started_at present). Coarse state only in F1 - the precise
  // "Section N of M" fraction needs a per-doc step total, which
  // would require loading document_content per row and should not
  // live in loadRoom. A plain "In progress" line is the honest
  // state until that loader change lands.
  const eyebrow = item.started ? "Pick up where you left off" : "Start next";
  const ctaLabel = item.started ? "Continue reading" : "Start reading";
  const subBits: string[] = [];
  if (item.total_parts > 1) {
    const mod = partShortTitle(item.source_section);
    subBits.push(mod ? `Part ${item.part_number} of ${item.total_parts} - ${mod}` : `Part ${item.part_number} of ${item.total_parts}`);
  } else if (item.card_line) {
    subBits.push(item.card_line);
  }
  if (minutes > 0) subBits.push(`${minutes} min`);
  const sub = subBits.join(" - ");

  return (
    <Link
      href={`/academy/read/${item.requirement_id}`}
      className="kf-hero-card"
      aria-label={`${eyebrow}: ${item.doc_title}`}
    >
      <div className="kf-hero-card__text">
        <span className="kf-hero-card__eyebrow">{eyebrow}</span>
        <h2 className="kf-hero-card__title">{item.doc_title}</h2>
        {sub ? <p className="kf-hero-card__sub">{sub}</p> : null}
        {item.started ? (
          <p className="kf-hero-card__sub" style={{ color: "var(--sp-navy)" }}>In progress</p>
        ) : null}
      </div>
      <div className="kf-hero-card__cta">
        <span className="kf-btn kf-btn--primary">
          <span>{ctaLabel}</span>
          <ChevronRight size={16} strokeWidth={1.5} />
        </span>
      </div>
    </Link>
  );
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
  if (item.total_parts > 1) {
    const module = partShortTitle(item.source_section);
    subParts.push(module ? `Part ${item.part_number} of ${item.total_parts} - ${module}` : `Part ${item.part_number} of ${item.total_parts}`);
  } else if (item.card_line) {
    subParts.push(item.card_line);
  }
  if (item.est_minutes > 0) subParts.push(`${item.est_minutes} min`);
  const sub = subParts.join(" - ");

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

/* ------------------------------------------------------------------ */

function RecordRail({ recordsRes }: { recordsRes: Awaited<ReturnType<typeof loadRecords>> }) {
  const sigs = recordsRes.ok ? recordsRes.mine.signatures.slice(0, 3) : [];
  if (sigs.length === 0) {
    return (
      <section className="kf-rail-card" aria-label="Your record">
        <h3 className="kf-rail-card__title">Your record</h3>
        <p className="kf-rail-card__body">
          Signatures land here as receipts. The full list lives on Done.
        </p>
        <Link href="/academy/done" className="kf-btn kf-btn--line" style={{ alignSelf: "flex-start" }}>
          Open Done
        </Link>
      </section>
    );
  }
  return (
    <section className="kf-rail-card" aria-label="Your record">
      <h3 className="kf-rail-card__title">Your record</h3>
      {sigs.map((s) => (
        <Link key={String(s.attestation_id)} href={s.certificate_href} className="kf-rail-cert" prefetch={false}>
          <span className="kf-rail-cert__text">
            <span className="kf-rail-cert__title">{s.doc.title}</span>
            {s.certificate_serial ? (
              <span className="kf-rail-cert__ref">{s.certificate_serial}</span>
            ) : null}
          </span>
          <span className="kf-rail-cert__pdf" aria-label="Download PDF">
            <Download size={16} strokeWidth={1.5} />
          </span>
        </Link>
      ))}
      <Link href="/academy/done" className="kf-btn kf-btn--line" style={{ alignSelf: "flex-start" }}>
        See Done
      </Link>
    </section>
  );
}

function HowThisWorksCard() {
  return (
    <section className="kf-rail-card" aria-label="How this works">
      <h3 className="kf-rail-card__title">How this works</h3>
      <p className="kf-rail-card__body">
        Read all of a document. Answer a couple of questions. Type your
        name to sign - the system records a certificate under your
        session. Nothing is recorded until you sign.
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ */

function AllSetPage({
  viewer,
  recordsRes,
}: {
  viewer: { displayName: string | null; record: { signedAllTime: number } };
  recordsRes: Awaited<ReturnType<typeof loadRecords>>;
}) {
  const name = firstName(viewer.displayName);
  const sigs = recordsRes.ok ? recordsRes.mine.signatures : [];
  const minutes = sigs.reduce((acc, s) => acc + (s.minutes || 0), 0);
  const days = 0; // "N days early" needs a cycle deadline reference we do not expose here yet; show "-".

  return (
    <div className="kf-academy">
      <div className="kf-academy__wash" aria-hidden />
      <AcademyBand
        eyebrow="Academy"
        title={name ? `You are all set, ${name}` : "You are all set"}
        kick="Nothing to do until the next one is published."
        cta={{ label: "Your record", href: "/academy/done" }}
      />
      <div className="kf-academy__single">
        <IdentLine displayName={viewer.displayName} />
        <PhoneStatus title={name ? `You are all set, ${name}` : "You are all set"} />
        <section className="kf-allset-center" aria-label="All set">
          <h2 className="kf-allset-center__title">That is everything.</h2>
          <p className="kf-allset-center__kick">
            {viewer.record.signedAllTime === 1 ? "One signed" : `${viewer.record.signedAllTime} signed`}
            {minutes > 0 ? `, ${minutes} minutes read` : ""}
            {days > 0 ? `, ${days} days early.` : "."}
          </p>
          <div className="kf-allset-nums">
            <div className="kf-allset-num">
              <span className="kf-allset-num__value">{viewer.record.signedAllTime}</span>
              <span className="kf-allset-num__label">Signed</span>
            </div>
            <div className="kf-allset-num">
              <span className="kf-allset-num__value">{minutes}</span>
              <span className="kf-allset-num__label">Minutes read</span>
            </div>
            <div className="kf-allset-num">
              <span className="kf-allset-num__value">-</span>
              <span className="kf-allset-num__label">Days early</span>
            </div>
          </div>
          <ul className="kf-allset-rows" aria-label="Receipts">
            {sigs.slice(0, 6).map((s) => (
              <li key={String(s.attestation_id)}>
                <article className="kf-receipt kf-receipt--row">
                  <h3 className="kf-receipt__title">{s.doc.title}</h3>
                  <p className="kf-receipt__module">
                    {s.certificate_serial ? `Certificate ${s.certificate_serial}` : "Signed"}
                    {s.signed_at ? ` - ${fmtDate(s.signed_at, "short")}` : ""}
                  </p>
                </article>
              </li>
            ))}
          </ul>
          <p className="kf-allset-footer">
            This page shows once. Next visit, To do rests: &ldquo;Nothing to do{ name ? `, ${name}` : "" }.&rdquo;
          </p>
        </section>
      </div>
      <Footer />
    </div>
  );
}

/* ------------------------------------------------------------------ */

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
