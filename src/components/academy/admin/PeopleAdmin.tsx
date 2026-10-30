"use client";

// Admin / People. One client island owns every interaction on the
// page: search filter, outstanding-only toggle, row expand, and the
// assign/unassign-region-lead dialog. The server page passes the
// pre-loaded roster + leads + canonical regions and never crosses
// the RSC boundary with a function or event handler.
//
// Scope note (visible in the UI): grants (academy_grants) and the
// per-person eligibility exceptions (academy_eligibility_exceptions)
// are managed in Supabase Studio for E3; a dedicated editor arrives
// in a later train.

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Search as SearchIcon,
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  Loader2,
  Users as UsersIcon,
} from "lucide-react";
import { fmtDate } from "@/lib/fmt";
import type { AdminPeopleView, PersonRow, RegionLead } from "@/lib/academy/admin/people";
import { AcademyBand, type AcademyBandFact } from "@/components/academy/AcademyBand";

// Date-only formatter for stored `date` columns (due_date, waived
// day). Parsing a bare "YYYY-MM-DD" through Date.parse makes it UTC
// midnight, which fmtDate then renders in Chicago as the previous
// day. This helper trims to the first 10 chars and formats the parts
// directly so the day label matches the stored value for every
// viewer. See docs/GOTCHAS.md item 4 (toLocaleString on the server
// renders in UTC).
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

type Props = { view: AdminPeopleView };

type Dialog =
  | { kind: "none" }
  | { kind: "assign"; email: string; region: string; busy: boolean; error?: string }
  | { kind: "unassign"; region: string; email: string; busy: boolean; error?: string };

function statusText(p: PersonRow): string {
  if (p.signed === 0 && p.outstanding === 0 && p.waived === 0) return "Nothing assigned";
  if (p.outstanding === 0) return "All done";
  return `${p.outstanding} outstanding`;
}

function statusToneClass(p: PersonRow): string {
  // Red only when something is overdue (next_due_at is in the past
  // and still outstanding). "Outstanding but not yet due" renders in
  // the neutral/warn tone, matching the design law (red only for a
  // real blocker).
  if (p.outstanding === 0) return "kf-ppl__status kf-ppl__status--good";
  if (p.next_due_at) {
    const todayYmd = new Date().toISOString().slice(0, 10);
    if (p.next_due_at.slice(0, 10) < todayYmd) return "kf-ppl__status kf-ppl__status--block";
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

export function PeopleAdmin({ view }: Props) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [outstandingOnly, setOutstandingOnly] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null); // worker_id
  const [dialog, setDialog] = useState<Dialog>({ kind: "none" });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return view.roster.filter((p) => {
      if (outstandingOnly && p.outstanding === 0) return false;
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
  }, [view.roster, query, outstandingOnly]);

  // Lead lookup, cheap search for the assign dialog's picker. One
  // Map keyed by email, keeping the display_name shows the owner
  // which person they're attaching to a region.
  const leadByRegion = useMemo(() => {
    const m = new Map<string, RegionLead>();
    for (const l of view.leads) m.set(l.region, l);
    return m;
  }, [view.leads]);

  const openAssign = useCallback(
    (defaultRegion: string, defaultEmail: string) => {
      setDialog({ kind: "assign", region: defaultRegion, email: defaultEmail, busy: false });
    },
    [],
  );
  const openUnassign = useCallback((region: string, email: string) => {
    setDialog({ kind: "unassign", region, email, busy: false });
  }, []);

  const doAssign = useCallback(
    async (region: string, email: string) => {
      setDialog((d) => (d.kind === "assign" ? { ...d, busy: true, error: undefined } : d));
      try {
        const res = await fetch("/api/academy/admin/people/region-leads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ region, email }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setDialog({
            kind: "assign",
            region,
            email,
            busy: false,
            error: data.detail || data.error || `HTTP ${res.status}`,
          });
          return;
        }
        setDialog({ kind: "none" });
        router.refresh();
      } catch (err) {
        setDialog({
          kind: "assign",
          region,
          email,
          busy: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [router],
  );

  const doUnassign = useCallback(
    async (region: string, email: string) => {
      setDialog((d) => (d.kind === "unassign" ? { ...d, busy: true, error: undefined } : d));
      try {
        const params = new URLSearchParams({ region, email });
        const res = await fetch(`/api/academy/admin/people/region-leads?${params.toString()}`, {
          method: "DELETE",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setDialog({
            kind: "unassign",
            region,
            email,
            busy: false,
            error: data.detail || data.error || `HTTP ${res.status}`,
          });
          return;
        }
        setDialog({ kind: "none" });
        router.refresh();
      } catch (err) {
        setDialog({
          kind: "unassign",
          region,
          email,
          busy: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [router],
  );

  // Band facts, computed from the loaded roster + leads only. All
  // three fact values count distinct PEOPLE (never a sum of items),
  // so the band's chips align with the render's intent and never
  // over-count against the roster size. loadAdminPeople's per-row
  // `outstanding` is a per-person item count (1 person can own
  // several outstanding items); summing it would quietly over-report.
  //   N = roster.length
  //   K = people with nothing assigned           (signed+outstanding+waived === 0)
  //   X = people with >= 1 outstanding item      (outstanding > 0)
  //   Y = people whose earliest outstanding is already past today
  //       (outstanding > 0 && next_due_at < today, UTC-safe date-only compare)
  const todayYmd = new Date().toISOString().slice(0, 10);
  const { N, K, X, Y } = useMemo(() => {
    let n = view.roster.length;
    let k = 0;
    let x = 0;
    let y = 0;
    for (const p of view.roster) {
      if (p.signed + p.outstanding + p.waived === 0) k += 1;
      if (p.outstanding > 0) x += 1;
      if (p.outstanding > 0 && p.next_due_at && p.next_due_at.slice(0, 10) < todayYmd) {
        y += 1;
      }
    }
    return { N: n, K: k, X: x, Y: y };
  }, [view.roster, todayYmd]);

  // Short "S. Lynch" label from "Sierra Lynch" (first initial + last
  // word). Falls back to email local-part when no display_name.
  const leadShort = useCallback((l: RegionLead): string => {
    const name = (l.display_name || "").trim();
    if (name) {
      const parts = name.split(/\s+/);
      if (parts.length >= 2) {
        return `${parts[0][0]}. ${parts[parts.length - 1]}`;
      }
      return name;
    }
    const local = (l.email || "").split("@")[0];
    return local || l.email;
  }, []);
  const leadsClause = view.leads.length === 0
    ? ""
    : ` Region leads: ${view.leads.map((l) => `${leadShort(l)} (${l.region})`).join(", ")}.`;

  const bandTitle = `${N} people - ${K} have nothing assigned`;
  const bandKick = `${X} outstanding, ${Y} overdue.${leadsClause}`;
  const bandFacts: AcademyBandFact[] = [
    { label: "People", value: N },
    { label: "Outstanding", value: X },
    { label: "Overdue", value: Y },
  ];
  const phoneStatus = `${N} people - ${X} outstanding, ${Y} overdue`;

  return (
    <div className="kf-admin">
      <AcademyBand
        eyebrow="Admin"
        title={bandTitle}
        kick={bandKick}
        facts={bandFacts}
      />
      <p className="kf-pstatus" aria-label="Status">{phoneStatus}</p>
      <p className="kf-admin__sub kf-admin__sub--standalone">
        {view.roster.length} active {view.roster.length === 1 ? "person" : "people"} on the
        roster. Compliance here reads the same engine Records uses. Grants and eligibility
        exceptions are managed in Studio for this train.
      </p>

      <section className="kf-ppl-leads" aria-label="Region leads">
        <header className="kf-ppl-leads__head">
          <h3 className="kf-ppl-leads__title">Region leads</h3>
          <p className="kf-ppl-leads__sub">
            A lead reviews their region&apos;s compliance in Team (next train).
          </p>
        </header>
        <div className="kf-ppl-leads__grid">
          {view.regions.length === 0 ? (
            <div className="kf-ppl-leads__empty">No regions on file.</div>
          ) : (
            view.regions.map((region) => {
              const l = leadByRegion.get(region) || null;
              return (
                <article key={region} className="kf-ppl-leads__row">
                  <div className="kf-ppl-leads__region">
                    <span className="kf-ppl-leads__region-label">Region</span>
                    <span className="kf-ppl-leads__region-name">{region}</span>
                  </div>
                  <div className="kf-ppl-leads__assignee">
                    {l ? (
                      <>
                        <span className="kf-ppl-leads__name">
                          {l.display_name || l.email}
                        </span>
                        <span className="kf-ppl-leads__email">{l.email}</span>
                        {l.assigned_at ? (
                          <span className="kf-ppl-leads__meta">
                            Assigned {fmtDate(l.assigned_at, "short")}
                            {l.assigned_by ? ` by ${l.assigned_by}` : ""}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <span className="kf-ppl-leads__none">No lead assigned</span>
                    )}
                  </div>
                  <div className="kf-ppl-leads__actions">
                    {l ? (
                      <button
                        type="button"
                        className="kf-cycle__btn kf-cycle__btn--danger"
                        onClick={() => openUnassign(region, l.email)}
                        aria-label={`Unassign ${l.email} from ${region}`}
                      >
                        <Trash2 size={14} strokeWidth={1.5} />
                        <span>Unassign</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="kf-cycle__btn kf-cycle__btn--primary"
                        onClick={() => openAssign(region, "")}
                      >
                        <Plus size={14} strokeWidth={1.5} />
                        <span>Assign</span>
                      </button>
                    )}
                  </div>
                </article>
              );
            })
          )}
        </div>
      </section>

      <section className="kf-ppl" aria-label="People roster">
        <header className="kf-ppl__head">
          <h3 className="kf-ppl__title">Roster</h3>
          <div className="kf-ppl__filters">
            <label className="kf-ppl__search">
              <SearchIcon size={14} strokeWidth={1.5} aria-hidden />
              <input
                type="search"
                className="kf-input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name, email, site..."
                aria-label="Search roster"
              />
            </label>
            <label className="kf-ppl__toggle">
              <input
                type="checkbox"
                checked={outstandingOnly}
                onChange={(e) => {
                  const v = e.currentTarget.checked;
                  setOutstandingOnly(v);
                }}
              />
              <span>Outstanding only</span>
            </label>
          </div>
        </header>

        {filtered.length === 0 ? (
          <div className="kf-ppl__empty">
            <UsersIcon size={24} strokeWidth={1.5} aria-hidden />
            <span>
              {view.roster.length === 0
                ? "No active people on the roster."
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
                    aria-controls={`ppl-detail-${p.worker_id}`}
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
                    <div className="kf-ppl__detail" id={`ppl-detail-${p.worker_id}`}>
                      <dl className="kf-ppl__kv">
                        <div>
                          <dt>Email</dt>
                          <dd>{p.work_email || "-"}</dd>
                        </div>
                        <div>
                          <dt>Worker id</dt>
                          <dd className="kf-ppl__mono">{p.worker_id}</dd>
                        </div>
                        <div>
                          <dt>Person id</dt>
                          <dd className="kf-ppl__mono">{p.person_id || "(no stint)"}</dd>
                        </div>
                        <div>
                          <dt>Site leader</dt>
                          <dd>{p.is_site_leader ? "Yes" : "No"}</dd>
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

      {dialog.kind === "assign" ? (
        <AssignLeadDialog
          regions={view.regions}
          region={dialog.region}
          email={dialog.email}
          busy={dialog.busy}
          error={dialog.error}
          roster={view.roster}
          leadByRegion={leadByRegion}
          onCancel={() => setDialog({ kind: "none" })}
          onPickRegion={(region) =>
            setDialog({ kind: "assign", region, email: dialog.email, busy: false })
          }
          onPickEmail={(email) =>
            setDialog({ kind: "assign", region: dialog.region, email, busy: false })
          }
          onSubmit={() => doAssign(dialog.region, dialog.email)}
        />
      ) : null}

      {dialog.kind === "unassign" ? (
        <UnassignLeadDialog
          region={dialog.region}
          email={dialog.email}
          busy={dialog.busy}
          error={dialog.error}
          onCancel={() => setDialog({ kind: "none" })}
          onConfirm={() => doUnassign(dialog.region, dialog.email)}
        />
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------
// Assign dialog
// ------------------------------------------------------------------

function AssignLeadDialog({
  regions,
  region,
  email,
  busy,
  error,
  roster,
  leadByRegion,
  onCancel,
  onPickRegion,
  onPickEmail,
  onSubmit,
}: {
  regions: string[];
  region: string;
  email: string;
  busy: boolean;
  error: string | undefined;
  roster: PersonRow[];
  leadByRegion: Map<string, RegionLead>;
  onCancel: () => void;
  onPickRegion: (r: string) => void;
  onPickEmail: (e: string) => void;
  onSubmit: () => void;
}) {
  const alreadyLead = region ? leadByRegion.get(region) : null;
  const canSubmit = !!region && !!email && !busy;
  return (
    <div className="kf-dialog-wrap" role="dialog" aria-modal="true" aria-label="Assign region lead">
      <div className="kf-dialog">
        <div className="kf-dialog__head">
          <h3 className="kf-dialog__title">Assign region lead</h3>
          <button type="button" className="kf-dialog__close" onClick={onCancel}>
            Cancel
          </button>
        </div>
        <div className="kf-dialog__body">
          <div className="kf-field">
            <label className="kf-field__label" htmlFor="lead-region">Region</label>
            <select
              id="lead-region"
              className="kf-input"
              value={region}
              onChange={(e) => {
                const v = e.currentTarget.value;
                onPickRegion(v);
              }}
            >
              <option value="">Pick a region</option>
              {regions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            {alreadyLead ? (
              <span className="kf-field__hint">
                Current lead for {region}: {alreadyLead.display_name || alreadyLead.email}.
                Assigning will replace them.
              </span>
            ) : null}
          </div>
          <div className="kf-field">
            <label className="kf-field__label" htmlFor="lead-email">Person</label>
            <select
              id="lead-email"
              className="kf-input"
              value={email}
              onChange={(e) => {
                const v = e.currentTarget.value;
                onPickEmail(v);
              }}
            >
              <option value="">Pick a person</option>
              {roster
                .filter((p) => !!p.work_email)
                .map((p) => (
                  <option key={p.worker_id} value={p.work_email as string}>
                    {p.display_name || p.work_email} - {p.account_key || "no site"}
                  </option>
                ))}
            </select>
            <span className="kf-field__hint">
              The lead must have a work_email in the active roster. Site is informational
              only - the lead role is scoped to the chosen region.
            </span>
          </div>
          {error ? (
            <div className="kf-form-errors" role="alert">
              <strong>Could not assign:</strong> {error}
            </div>
          ) : null}
        </div>
        <div className="kf-dialog__foot">
          <button type="button" className="kf-dialog__close" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={`kf-cycle__btn kf-cycle__btn--primary${busy ? " is-busy" : ""}`}
            onClick={onSubmit}
            disabled={!canSubmit}
          >
            {busy ? <Loader2 size={14} strokeWidth={1.5} /> : <Plus size={14} strokeWidth={1.5} />}
            <span>{busy ? "Assigning..." : "Assign lead"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Unassign dialog
// ------------------------------------------------------------------

function UnassignLeadDialog({
  region,
  email,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  region: string;
  email: string;
  busy: boolean;
  error: string | undefined;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="kf-dialog-wrap" role="dialog" aria-modal="true" aria-label="Unassign region lead">
      <div className="kf-dialog">
        <div className="kf-dialog__head">
          <h3 className="kf-dialog__title">Unassign {email}</h3>
          <button type="button" className="kf-dialog__close" onClick={onCancel}>
            Cancel
          </button>
        </div>
        <div className="kf-dialog__body">
          <p>
            Removes <strong>{email}</strong> as lead of <strong>{region}</strong>. The person&apos;s
            own roster row stays intact; only the lead assignment is deleted.
          </p>
          {error ? (
            <div className="kf-form-errors" role="alert">
              <strong>Could not unassign:</strong> {error}
            </div>
          ) : null}
        </div>
        <div className="kf-dialog__foot">
          <button type="button" className="kf-dialog__close" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={`kf-cycle__btn kf-cycle__btn--danger${busy ? " is-busy" : ""}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? <Loader2 size={14} strokeWidth={1.5} /> : <Trash2 size={14} strokeWidth={1.5} />}
            <span>{busy ? "Unassigning..." : "Unassign"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
