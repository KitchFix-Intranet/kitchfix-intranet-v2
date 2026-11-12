"use client";

// Inbox client island (T3, 2026-11-13). Matches the approved render's
// renderInbox() output class-by-class, without any of the write
// controls that live in later trains (Nudge, Withdraw, Fix, Discard).
//
//   - Toolbar: search (only when the active list has > 10 rows),
//     Sent-by-me / About-my-team switch (only for SL + RD), type
//     chips (only when the list has more than one kind).
//   - Four groups on "Sent by me": Needs you · Just decided ·
//     Pending · Earlier (with "Show N more" after 5).
//   - Two groups on "About my team": Pending · Decided (with
//     "Show N more" after 8).
//   - Phone: toolbar stacks; chip row scrolls sideways; table
//     becomes row-flex cards (render's @media rules).
//
// Row click sets ?rec=<id>. The drawer renders server-side on
// /people/inbox based on that param; no payload lives in client
// state.

import { useCallback, useMemo, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Search as SearchIcon, ChevronRight, ClipboardList, UserPlus, TriangleAlert } from "lucide-react";
import type { InboxRow, InboxKind, InboxView, InboxGroup } from "@/lib/people/inboxTypes";

type Props = {
  view: InboxView;
};

type TabKey = "mine" | "team";

const KIND_WORD: Record<InboxKind, string> = {
  paf: "PAF",
  hire: "New Hire",
  incident: "Incident",
};

function KindIcon({ kind }: { kind: InboxKind }) {
  const Comp = kind === "incident" ? TriangleAlert : kind === "hire" ? UserPlus : ClipboardList;
  return (
    <span className={`kf-pe-kind kf-pe-kind--${kind}`} aria-hidden>
      <Comp size={16} strokeWidth={1.5} />
    </span>
  );
}

function StatusPill({ row }: { row: InboxRow }) {
  const tone =
    row.status_code === "Complete" ? "kf-pill--good" :
    row.status_code === "Rejected" ? "kf-pill--block" :
    row.status_code === "Pending" ? "kf-pill--info" :
    "kf-pill--muted";
  return <span className={`kf-pill ${tone} kf-pe-pill`}>{row.status_display}</span>;
}

function Row({
  row, needs, onOpen,
}: { row: InboxRow; needs: boolean; onOpen: (id: string) => void }) {
  const cls = [
    "kf-pe-row",
    row.unread ? "is-unread" : "",
    row.status_code === "Withdrawn" || row.status_code === "Cancelled" ? "is-gone" : "",
  ].filter(Boolean).join(" ");
  return (
    <tr
      className={cls}
      tabIndex={0}
      role="button"
      onClick={() => onOpen(row.id)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(row.id); } }}
      aria-label={`Open ${row.title}`}
    >
      <td className="kf-pe-what">
        <KindIcon kind={row.kind} />
        <span className="kf-pe-what__text">
          <b>
            {row.unread ? <i className="kf-pe-unread" aria-label="New" /> : null}
            {row.title}
          </b>
          <small>
            {row.subline}
            {needs && row.why_text ? (
              <span className={`kf-pe-why${row.status_code === "Pending" ? " is-late" : ""}`}>
                {row.why_text}
              </span>
            ) : null}
          </small>
        </span>
      </td>
      <td className={`kf-pe-num${row.amount_display ? "" : " is-empty"}`}>{row.amount_display}</td>
      <td className="kf-pe-status"><StatusPill row={row} /></td>
      <td className="kf-pe-when">
        <time>{row.decided_short ?? row.sent_short}</time>
      </td>
      <td className="kf-pe-act">
        <ChevronRight size={18} strokeWidth={1.5} aria-hidden />
      </td>
    </tr>
  );
}

function Group({
  label, note, right, rows, needs, onOpen,
}: {
  label: string; note?: string; right?: React.ReactNode;
  rows: InboxRow[]; needs: boolean;
  onOpen: (id: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <>
      <tr className="kf-pe-grouprow">
        <td colSpan={5}>
          <div className="kf-pe-grouprow__in">
            <span>{label}</span>
            {note ? <small>{note}</small> : null}
            {right}
            <b>{rows.length}</b>
          </div>
        </td>
      </tr>
      {rows.map((r) => <Row key={r.id} row={r} needs={needs} onOpen={onOpen} />)}
    </>
  );
}

export function Inbox({ view }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const [tab, setTab] = useState<TabKey>("mine");
  const [kindFilter, setKindFilter] = useState<InboxKind | "all">("all");
  const [query, setQuery] = useState("");
  const [showMoreEarlier, setShowMoreEarlier] = useState(false);
  const [showMoreTeam, setShowMoreTeam] = useState(false);

  const buildHref = useCallback((patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === "") next.delete(k);
      else next.set(k, v);
    }
    const s = next.toString();
    return s ? `${pathname}?${s}` : pathname;
  }, [sp, pathname]);

  const openRow = useCallback((id: string) => {
    router.push(buildHref({ rec: id }));
  }, [router, buildHref]);

  const active: InboxRow[] = tab === "team" ? view.team : view.mine;

  // Type chips come from the active list - "show only when the viewer
  // has more than one kind" (per prompt).
  const kindsInList = useMemo(() => {
    const set = new Set<InboxKind>();
    for (const r of active) set.add(r.kind);
    return Array.from(set);
  }, [active]);
  const showChips = kindsInList.length > 1;
  // If the current filter is not present in the list (e.g. switched
  // tabs), fall back to "all".
  const effectiveKind: InboxKind | "all" = kindFilter !== "all" && !kindsInList.includes(kindFilter) ? "all" : kindFilter;

  // Search comes in only when > 10 rows are in the active list OR
  // a query is already typed.
  const showSearch = active.length > 10 || query.trim().length > 0;
  const q = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    return active.filter((r) => {
      if (effectiveKind !== "all" && r.kind !== effectiveKind) return false;
      if (!q) return true;
      const hay = [r.title, r.subline, r.action_label, r.amount_display, r.status_display, KIND_WORD[r.kind]].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [active, effectiveKind, q]);

  const byGroup = useMemo(() => {
    const out: Record<InboxGroup, InboxRow[]> = { needs: [], news: [], pending: [], earlier: [] };
    for (const r of filtered) out[r.group].push(r);
    return out;
  }, [filtered]);

  const hasAny = view.mine.length > 0 || view.team.length > 0;

  function TabSwitch() {
    if (!view.hasTeamSwitch || view.team.length === 0) return null;
    const teamUnread = view.team.filter((r) => r.unread).length;
    return (
      <div className="kf-pe-seg" role="group" aria-label="Whose">
        <button
          type="button"
          onClick={() => { setTab("mine"); setShowMoreEarlier(false); setShowMoreTeam(false); }}
          aria-pressed={tab === "mine" ? "true" : "false"}
        >
          Sent by me
        </button>
        <button
          type="button"
          onClick={() => { setTab("team"); setShowMoreEarlier(false); setShowMoreTeam(false); }}
          aria-pressed={tab === "team" ? "true" : "false"}
        >
          About my team{teamUnread > 0 ? ` · ${teamUnread} new` : ""}
        </button>
      </div>
    );
  }

  function Chips() {
    if (!showChips) return null;
    return (
      <div className="kf-pe-chips kf-pe-chips--chef" role="group" aria-label="Type">
        <button
          className="kf-pe-chip kf-pe-chip--type"
          type="button"
          onClick={() => setKindFilter("all")}
          aria-pressed={effectiveKind === "all" ? "true" : "false"}
        >
          All
        </button>
        {kindsInList.map((k) => (
          <button
            key={k}
            className="kf-pe-chip kf-pe-chip--type"
            type="button"
            onClick={() => setKindFilter(k)}
            aria-pressed={effectiveKind === k ? "true" : "false"}
          >
            {KIND_WORD[k]}
          </button>
        ))}
      </div>
    );
  }

  function SearchField() {
    if (!showSearch) return null;
    return (
      <label className="kf-pe-field kf-pe-field--search kf-pe-search kf-pe-search--inbox" aria-label="Find a person, a site or an action">
        <span className="kf-pe-search__ico" aria-hidden>
          <SearchIcon size={18} strokeWidth={1.5} />
        </span>
        <input
          type="search"
          placeholder="Find a person, a site or an action"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
    );
  }

  // Empty state when the viewer has nothing anywhere.
  if (!hasAny) {
    return (
      <div className="kf-pe-emptywrap">
        <div className="kf-pe-empty">
          <strong>Nothing sent yet.</strong>
          <span>PAFs and New Hires you send show here, with what needs you and where each one stands.</span>
        </div>
      </div>
    );
  }

  // Build the body. On "mine" we show four groups; on "team" we show
  // Pending + Decided with "Show more" after 8.
  function renderBody() {
    if (q) {
      // Search view: one group with all matches, newest first.
      const sorted = [...filtered].sort((a, b) => (b.sent_long || "").localeCompare(a.sent_long || ""));
      if (sorted.length === 0) {
        return (
          <tr className="kf-pe-more">
            <td colSpan={5}>
              <button type="button" onClick={() => setQuery("")}>
                Nothing matches. Clear the search
              </button>
            </td>
          </tr>
        );
      }
      return (
        <Group
          label={sorted.length === 1 ? "Match" : "Matches"}
          note="newest first"
          rows={sorted}
          needs={false}
          onOpen={openRow}
        />
      );
    }
    if (tab === "team") {
      const open = filtered.filter((r) => r.status_code === "Pending");
      const rest = filtered.filter((r) => r.status_code !== "Pending");
      const cap = 8;
      const cut = !showMoreTeam && rest.length > cap;
      const shown = cut ? rest.slice(0, cap) : rest;
      return (
        <>
          <Group label="Pending" note="sent by someone else, about your people" rows={open} needs={false} onOpen={openRow} />
          <Group label="Decided" rows={shown} needs={false} onOpen={openRow} />
          {cut ? (
            <tr className="kf-pe-more">
              <td colSpan={5}>
                <button type="button" onClick={() => setShowMoreTeam(true)}>
                  Show {rest.length - cap} more
                </button>
              </td>
            </tr>
          ) : null}
        </>
      );
    }
    const earlierCap = 5;
    const cutEarlier = !showMoreEarlier && byGroup.earlier.length > earlierCap;
    const earlierShown = cutEarlier ? byGroup.earlier.slice(0, earlierCap) : byGroup.earlier;
    return (
      <>
        <Group label="Needs you" note="finish it, fix it, or chase it" rows={byGroup.needs} needs onOpen={openRow} />
        <Group label="Just decided" note="not opened yet" rows={byGroup.news} needs={false} onOpen={openRow} />
        <Group label="Pending" note="someone else has it now" rows={byGroup.pending} needs={false} onOpen={openRow} />
        <Group label="Earlier" rows={earlierShown} needs={false} onOpen={openRow} />
        {cutEarlier ? (
          <tr className="kf-pe-more">
            <td colSpan={5}>
              <button type="button" onClick={() => setShowMoreEarlier(true)}>
                Show {byGroup.earlier.length - earlierCap} more
              </button>
            </td>
          </tr>
        ) : null}
      </>
    );
  }

  return (
    <>
      <div className="kf-pe-inboxbar">
        <SearchField />
        <TabSwitch />
        <Chips />
      </div>
      <div className="kf-pe-tablecard">
        <table className="kf-pe-table kf-pe-table--inbox">
          <colgroup>
            <col />
            <col className="c-num" />
            <col className="c-status" />
            <col className="c-when" />
            <col className="c-act" />
          </colgroup>
          <thead>
            <tr>
              <th>Request</th>
              <th className="kf-pe-num">Amount</th>
              <th>Status</th>
              <th className="kf-pe-when">Date</th>
              <th />
            </tr>
          </thead>
          <tbody>{renderBody()}</tbody>
        </table>
      </div>
    </>
  );
}
