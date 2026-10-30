"use client";

// Team view - one client island, read-only.
//
// Behaviour:
//   - owner  -> picker selects scope (all / region / site), URL
//               carries ?scope=... so router.push triggers a
//               server fetch of the newly scoped roster.
//   - lead   -> no picker (scope is intrinsic). Toggle for
//               "behind only" (outstanding > 0 OR next_due in the
//               past), row-expand per person for details.
//   - empty  -> clean state ("No one reports to you yet" for leads;
//               "No people in this scope" for owner).
//
// Not reachable from here: assign, edit, sign. No `fetch` with a
// method other than GET; no onClick that posts anywhere.

import { useCallback, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, Search as SearchIcon, Users as UsersIcon } from "lucide-react";
import { fmtDate } from "@/lib/fmt";
import type { TeamView as TeamViewData, TeamPersonRow } from "@/lib/academy/team";

// Date-only formatter mirrors the one in PeopleAdmin so a stored
// YYYY-MM-DD column renders the day you stored, not a TZ-shifted
// previous day. See docs/GOTCHAS.md item 4 and the PeopleAdmin
// companion. Local to this file because the global fmt.ts fix is
// still held for the feedback pass.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDateOnly(iso: string | null): string {
  if (!iso) return "-";
  const ymd = iso.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return iso;
  const [y, m, d] = ymd.split("-").map((s) => parseInt(s, 10));
  if (!y || !m || !d) return iso;
  const yearPart = y === new Date().getFullYear() ? "" : `, ${y}`;
  return `${MONTHS[m - 1]} ${d}${yearPart}`;
}

type Props = { view: TeamViewData };

function statusText(p: TeamPersonRow): string {
  if (p.signed === 0 && p.outstanding === 0 && p.waived === 0) return "Nothing assigned";
  if (p.outstanding === 0) return "All done";
  return `${p.outstanding} outstanding`;
}

function statusToneClass(p: TeamPersonRow): string {
  if (p.outstanding === 0) return "kf-ppl__status kf-ppl__status--good";
  if (p.next_due_at) {
    const todayYmd = new Date().toISOString().slice(0, 10);
    if (p.next_due_at.slice(0, 10) < todayYmd) {
      return "kf-ppl__status kf-ppl__status--block";
    }
  }
  return "kf-ppl__status kf-ppl__status--warn";
}

function initials(name: string | null, fallbackEmail: string | null): string {
  const base = (name || "").trim();
  if (base) {
    const parts = base.split(/\s+/);
    const first = parts[0]?.[0] || "";
    const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
    return (first + last).toUpperCase() || base[0]?.toUpperCase() || "?";
  }
  const email = (fallbackEmail || "").trim();
  return (email[0] || "?").toUpperCase();
}

export function TeamView({ view }: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [query, setQuery] = useState("");
  const [behindOnly, setBehindOnly] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const todayYmd = new Date().toISOString().slice(0, 10);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return view.roster.filter((p) => {
      if (behindOnly) {
        const overdue = !!p.next_due_at && p.next_due_at.slice(0, 10) < todayYmd;
        const stillOpen = p.outstanding > 0;
        if (!stillOpen && !overdue) return false;
      }
      if (!q) return true;
      const hay =
        (p.display_name || "").toLowerCase() +
        " " +
        (p.work_email || "").toLowerCase() +
        " " +
        (p.account_key || "").toLowerCase() +
        " " +
        (p.region || "").toLowerCase() +
        " " +
        (p.title || "").toLowerCase();
      return hay.includes(q);
    });
  }, [view.roster, query, behindOnly, todayYmd]);

  const onPickScope = useCallback(
    (value: string) => {
      // Owner picker. Push the scope into the URL so the next render
      // re-fetches with the new filter on the server.
      startTransition(() => {
        const params = new URLSearchParams();
        if (value && value !== "all") params.set("scope", value);
        const q = params.toString();
        router.push(q ? `/academy/team?${q}` : "/academy/team");
      });
    },
    [router],
  );

  const subtitle = view.header.subtitle;
  const headerCount = view.roster.length;

  return (
    <div className="kf-admin">
      <header className="kf-admin__head">
        <div>
          <span className="kf-admin__eyebrow">Academy</span>
          <h2 className="kf-admin__title">{view.header.title}</h2>
          <p className="kf-admin__sub">
            {headerCount} {headerCount === 1 ? "person" : "people"} on this team.
            {subtitle ? ` ${subtitle}.` : ""} Review their training compliance - this
            page is read-only; a lead sees but does not assign or sign.
          </p>
        </div>
        {view.header.viewerIsOwner && view.scopeOptions.length > 0 ? (
          <div className="kf-admin__actions">
            <label className="kf-ppl__toggle" style={{ gap: "var(--sp-sp-2)" }}>
              <span style={{ color: "var(--sp-muted)", fontSize: "var(--sp-t-micro)" }}>Scope</span>
              <select
                className="kf-input"
                value={view.header.activeScope === "all" ? "all" : view.header.activeScope}
                onChange={(e) => {
                  const v = e.currentTarget.value;
                  onPickScope(v);
                }}
                aria-label="Scope"
                style={{ minWidth: 220 }}
              >
                {view.scopeOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label} ({o.count})
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}
      </header>

      <section className="kf-ppl" aria-label="Team roster">
        <header className="kf-ppl__head">
          <h3 className="kf-ppl__title">Compliance</h3>
          <div className="kf-ppl__filters">
            <label className="kf-ppl__search">
              <SearchIcon size={14} strokeWidth={1.5} aria-hidden />
              <input
                type="search"
                className="kf-input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name, email, site..."
                aria-label="Search team"
              />
            </label>
            <label className="kf-ppl__toggle">
              <input
                type="checkbox"
                checked={behindOnly}
                onChange={(e) => {
                  const v = e.currentTarget.checked;
                  setBehindOnly(v);
                }}
              />
              <span>Behind only</span>
            </label>
          </div>
        </header>

        {filtered.length === 0 ? (
          <div className="kf-ppl__empty">
            <UsersIcon size={24} strokeWidth={1.5} aria-hidden />
            <span>
              {view.roster.length === 0
                ? (view.header.viewerIsLead
                    ? "No one reports to you yet."
                    : "No people in this scope.")
                : "No one matches that filter."}
            </span>
          </div>
        ) : (
          <ul className="kf-ppl__list" role="list">
            {filtered.map((p) => {
              const open = expanded === p.worker_id;
              return (
                <li key={p.worker_id} className={`kf-ppl__row${open ? " kf-ppl__row--open" : ""}`}>
                  <button
                    type="button"
                    className="kf-ppl__head-row"
                    onClick={() => setExpanded((cur) => (cur === p.worker_id ? null : p.worker_id))}
                    aria-expanded={open}
                    aria-controls={`team-detail-${p.worker_id}`}
                  >
                    <span className="kf-ppl__avatar" aria-hidden>
                      {initials(p.display_name, p.work_email)}
                    </span>
                    <span className="kf-ppl__id">
                      <span className="kf-ppl__name">{p.display_name || "Unnamed"}</span>
                      <span className="kf-ppl__sub">
                        {[p.title, p.account_key, p.region].filter(Boolean).join(" - ") || "No role"}
                      </span>
                    </span>
                    <span className="kf-ppl__class" aria-label={`Class ${p.worker_class}`}>
                      {p.worker_class === "salaried" ? "Salaried" : "Hourly"}
                    </span>
                    <span className={statusToneClass(p)}>{statusText(p)}</span>
                    <span className="kf-ppl__chev" aria-hidden>
                      {open ? (
                        <ChevronDown size={16} strokeWidth={1.5} />
                      ) : (
                        <ChevronRight size={16} strokeWidth={1.5} />
                      )}
                    </span>
                  </button>
                  {open ? (
                    <div className="kf-ppl__detail" id={`team-detail-${p.worker_id}`}>
                      <dl className="kf-ppl__kv">
                        <div>
                          <dt>Email</dt>
                          <dd>{p.work_email || "-"}</dd>
                        </div>
                        <div>
                          <dt>Site</dt>
                          <dd>{p.account_key || "-"}</dd>
                        </div>
                        <div>
                          <dt>Region</dt>
                          <dd>{p.region || "-"}</dd>
                        </div>
                        <div>
                          <dt>Signed</dt>
                          <dd>{p.signed}</dd>
                        </div>
                        <div>
                          <dt>Outstanding</dt>
                          <dd>{p.outstanding}</dd>
                        </div>
                        <div>
                          <dt>Waived</dt>
                          <dd>{p.waived}</dd>
                        </div>
                        <div>
                          <dt>Last signed</dt>
                          <dd>{p.last_signed_at ? fmtDate(p.last_signed_at, "short") : "-"}</dd>
                        </div>
                        <div>
                          <dt>Next due</dt>
                          <dd>{fmtDateOnly(p.next_due_at)}</dd>
                        </div>
                      </dl>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
