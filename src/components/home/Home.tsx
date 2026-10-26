// Home. Identity band on desktop/tablet; state feed on phone. Six tool doors.
// Needs-you + Ledger cards reading real rows.

import Link from "next/link";
import {
  ChefHat,
  Users,
  Settings,
  Calendar,
  BarChart2,
  BookOpen,
  ArrowRight,
} from "lucide-react";
import { serviceClient } from "@/lib/supabase/service";
import "./home.css";

type Door = {
  href: string;
  Icon: typeof ChefHat;
  name: string;
  tagline: string;
  pill: string;
  pillTone: "live" | "reserved";
};

const DOORS: Door[] = [
  {
    href: "/people",
    Icon: Users,
    name: "People Portal",
    tagline: "Teams, roles, and the people who do the work.",
    pill: "On the current intranet",
    pillTone: "reserved",
  },
  {
    href: "/ops",
    Icon: Settings,
    name: "Ops Hub",
    tagline: "Receiving, closes, and the day-to-day running of a site.",
    pill: "On the current intranet",
    pillTone: "reserved",
  },
  {
    href: "/service",
    Icon: Calendar,
    name: "Service Calendar",
    tagline: "What is booked, who is leading, and what still needs confirming.",
    pill: "On the current intranet",
    pillTone: "reserved",
  },
  {
    href: "/kpi",
    Icon: BarChart2,
    name: "KPI Dashboard",
    tagline: "The numbers that run the business, period over period.",
    pill: "On the current intranet",
    pillTone: "reserved",
  },
  {
    href: "/academy",
    Icon: BookOpen,
    name: "Academy",
    tagline: "What every role is expected to know and how to learn it.",
    pill: "On the current intranet",
    pillTone: "reserved",
  },
  {
    href: "/stockpot",
    Icon: ChefHat,
    name: "Stockpot",
    tagline: "The culinary office - ingredients, recipes, menus, signs.",
    pill: "Live",
    pillTone: "live",
  },
];

type LedgerEvent = {
  id: string;
  kind: string;
  at: string;
  note: string | null;
};

type IntakeRun = {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: "running" | "ok" | "failed";
  counts: Record<string, unknown> | null;
};

type LedgerGroup = {
  kind: string;
  count: number;
  newest_at: string;
};

// Known event kinds get a human label + a plural form; unknown kinds fall
// back to a title-cased, hyphenated form of the enum so nothing ever renders
// a raw "vendor_item_twin" string.
const EVENT_LABELS: Record<string, { single: string; plural: string }> = {
  vendor_item_twin: { single: "twin flagged", plural: "twins flagged" },
  vendor_created: { single: "vendor created", plural: "vendors created" },
  status_changed: { single: "status change", plural: "status changes" },
};
function humanizeKind(kind: string, count: number): string {
  const label = EVENT_LABELS[kind];
  if (label) return count === 1 ? label.single : label.plural;
  const words = kind.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  if (!local) return "there";
  // Title-case the WHOLE local-part so "k.fietek" becomes "K.Fietek" rather
  // than the one-letter "K" we were showing. Not pretty, but never wrong.
  return local
    .split(".")
    .filter((p) => p.length > 0)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

function timeAgo(iso: string): string {
  const d = new Date(iso).getTime();
  if (!Number.isFinite(d)) return iso;
  const diff = Date.now() - d;
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  return `${days}d ago`;
}

function groupLedger(rows: LedgerEvent[], max: number): LedgerGroup[] {
  // Walk the time-ordered list; collapse consecutive same-kind rows into one
  // summary row carrying the group's size and the newest timestamp.
  const out: LedgerGroup[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.kind === r.kind) {
      last.count += 1;
      // Rows arrive newest-first, so the first one in a run has the newest at.
    } else {
      out.push({ kind: r.kind, count: 1, newest_at: r.at });
    }
    if (out.length >= max) break;
  }
  return out;
}

async function loadStatus(email: string) {
  try {
    const client = serviceClient();
    const [events, runs, nameRow] = await Promise.all([
      client
        .from("pr_events")
        .select("id,kind,at,note")
        .order("at", { ascending: false })
        .limit(50),
      client
        .from("pr_intake_runs")
        .select("id,started_at,finished_at,status,counts")
        .order("started_at", { ascending: false })
        .limit(1),
      client.from("pr_users").select("name").eq("email", email).maybeSingle(),
    ]);
    const ledger = groupLedger((events.data ?? []) as LedgerEvent[], 6);
    const nameFromDb = (nameRow.data as { name: string | null } | null)?.name ?? null;
    return {
      ledger,
      lastRun: ((runs.data ?? [])[0] ?? null) as IntakeRun | null,
      displayName: nameFromDb && nameFromDb.length > 0 ? nameFromDb : nameFromEmail(email),
    };
  } catch {
    return {
      ledger: [] as LedgerGroup[],
      lastRun: null as IntakeRun | null,
      displayName: nameFromEmail(email),
    };
  }
}

export async function Home({ email }: { email: string }) {
  const { ledger, lastRun, displayName } = await loadStatus(email);
  const statusLine =
    lastRun && lastRun.status === "ok"
      ? `1 of 6 tools live in the new shell. Last intake ${timeAgo(lastRun.started_at)}; the rest remain on the current intranet.`
      : "1 of 6 tools live in the new shell. The rest remain on the current intranet.";

  return (
    <>
      <section className="kf-ident kf-only-desktop" aria-label="Overview">
        <div className="kf-ident__sheen" aria-hidden />
        <div className="kf-ident__content">
          <span className="kf-eyebrow kf-ident__eyebrow">One shell, every tool</span>
          <h2 className="kf-ident__title">Welcome back, {displayName}</h2>
          <p className="kf-ident__status">{statusLine}</p>
          <Link href="/stockpot" className="kf-btn kf-btn--filled">
            Open Stockpot
            <ArrowRight size={16} strokeWidth={1.5} />
          </Link>
        </div>
      </section>

      <section className="kf-phone-status kf-only-phone" aria-label="Status">
        <span className="kf-eyebrow">KitchFix</span>
        <h2>Hello, {displayName}</h2>
        <p>{statusLine}</p>
      </section>

      <section className="kf-doors" aria-label="Tools">
        <ul className="kf-doors__grid">
          {DOORS.map(({ href, Icon, name, tagline, pill, pillTone }) => (
            <li key={href}>
              <Link href={href} className="kf-door">
                <span className="kf-door__icon" aria-hidden>
                  <Icon size={24} strokeWidth={1.5} />
                </span>
                <div className="kf-door__body">
                  <h3 className="kf-door__title">{name}</h3>
                  <p className="kf-door__tagline">{tagline}</p>
                  <span className={`kf-pill kf-pill--${pillTone}`}>{pill}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="kf-home-row" aria-label="Status cards">
        <article className="kf-card">
          <header>
            <span className="kf-eyebrow">Needs you</span>
            <h3>Nothing waiting yet</h3>
          </header>
          <p className="kf-card__muted">
            As ingredients, prices, and allergens start to flow through here,
            anything that needs a human decision will land in this card.
          </p>
        </article>

        <article className="kf-card">
          <header>
            <span className="kf-eyebrow">Ledger</span>
            <h3>Recent activity</h3>
          </header>
          {ledger.length === 0 ? (
            <p className="kf-card__muted">
              No events yet. Once intake runs or someone makes an edit, the
              last few actions will show here.
            </p>
          ) : (
            <ul className="kf-ledger">
              {ledger.map((g) => (
                <li key={`${g.kind}-${g.newest_at}`}>
                  <span className="kf-ledger__kind">
                    {g.count > 1 ? `${g.count.toLocaleString()} ${humanizeKind(g.kind, g.count)}` : humanizeKind(g.kind, g.count)}
                  </span>
                  <time>{timeAgo(g.newest_at)}</time>
                </li>
              ))}
            </ul>
          )}
          {lastRun ? (
            <footer className="kf-card__foot">
              Last intake: {new Date(lastRun.started_at).toLocaleString()} - {lastRun.status}
            </footer>
          ) : null}
        </article>
      </section>
    </>
  );
}
