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
  entity_type: string;
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

function firstName(email: string): string {
  const local = email.split("@")[0] ?? "";
  const base = local.split(".")[0] ?? local;
  if (!base) return "there";
  return base.charAt(0).toUpperCase() + base.slice(1);
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

async function loadStatus() {
  try {
    const client = serviceClient();
    const [events, runs] = await Promise.all([
      client
        .from("pr_events")
        .select("id,entity_type,kind,at,note")
        .order("at", { ascending: false })
        .limit(6),
      client
        .from("pr_intake_runs")
        .select("id,started_at,finished_at,status,counts")
        .order("started_at", { ascending: false })
        .limit(1),
    ]);
    return {
      events: (events.data ?? []) as LedgerEvent[],
      lastRun: ((runs.data ?? [])[0] ?? null) as IntakeRun | null,
    };
  } catch {
    return { events: [] as LedgerEvent[], lastRun: null as IntakeRun | null };
  }
}

export async function Home({ email }: { email: string }) {
  const { events, lastRun } = await loadStatus();
  const name = firstName(email);
  const statusLine =
    lastRun && lastRun.status === "ok"
      ? `1 of 6 tools live in the new shell. Last intake ${timeAgo(lastRun.started_at)}; the rest remain on the current intranet.`
      : "1 of 6 tools live in the new shell. The rest remain on the current intranet.";

  return (
    <>
      <section className="kf-ident kf-only-desktop" aria-label="Overview">
        <div className="kf-ident__sheen" aria-hidden />
        <div className="kf-ident__content">
          <span className="kf-eyebrow kf-ident__eyebrow">KitchFix - one shell, every tool</span>
          <h2 className="kf-ident__title">Welcome back, {name}</h2>
          <p className="kf-ident__status">{statusLine}</p>
          <Link href="/stockpot" className="kf-btn kf-btn--filled">
            Open Stockpot
            <ArrowRight size={16} strokeWidth={1.5} />
          </Link>
        </div>
      </section>

      <section className="kf-phone-status kf-only-phone" aria-label="Status">
        <span className="kf-eyebrow">KitchFix</span>
        <h2>Hello, {name}</h2>
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
                  <div className="kf-door__title-row">
                    <h3>{name}</h3>
                    <span className={`kf-pill kf-pill--${pillTone}`}>{pill}</span>
                  </div>
                  <p>{tagline}</p>
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
          {events.length === 0 ? (
            <p className="kf-card__muted">
              No events yet. Once intake runs or someone makes an edit, the
              last few actions will show here.
            </p>
          ) : (
            <ul className="kf-ledger">
              {events.map((e) => (
                <li key={e.id}>
                  <span className="kf-ledger__kind">{e.kind}</span>
                  <span className="kf-ledger__entity">{e.entity_type}</span>
                  <time>{timeAgo(e.at)}</time>
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
