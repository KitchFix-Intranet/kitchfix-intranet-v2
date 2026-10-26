// Home. R10 simple: an identity band on desktop + the door grid, nothing
// else. On phones the band collapses to a date eyebrow + welcome, two fact
// cards and a More tools card listing the three doors the tab bar does not
// carry. Home makes exactly one data read (pr_users.name for the greeting).

import Link from "next/link";
import {
  ChefHat,
  Users,
  Settings,
  Calendar,
  BarChart2,
  BookOpen,
  ExternalLink,
} from "lucide-react";
import { IdentBand } from "@/components/ui/IdentBand";
import { serviceClient } from "@/lib/supabase/service";
import { currentPeriod } from "@/lib/fiscalPeriod";
import { fmtDate } from "@/lib/fmt";
import "./home.css";

type Door = {
  href: string;
  external: boolean;
  Icon: typeof ChefHat;
  name: string;
  tagline: string;
  pillTone: "live" | "reserved";
};

const V1_BASE = "https://kitchfix-intranet.vercel.app";

// Stockpot first; the other five open on the current intranet. Taglines are
// verbatim from spec 12 R8.
const DOORS: Door[] = [
  {
    href: "/stockpot/ingredients",
    external: false,
    Icon: ChefHat,
    name: "Stockpot",
    tagline: "Ingredients, recipes, menus, signs.",
    pillTone: "live",
  },
  {
    href: `${V1_BASE}/people`,
    external: true,
    Icon: Users,
    name: "People Portal",
    tagline: "Teams, roles, and who does the work.",
    pillTone: "reserved",
  },
  {
    href: `${V1_BASE}/ops`,
    external: true,
    Icon: Settings,
    name: "Ops Hub",
    tagline: "Receiving, closes, the daily run.",
    pillTone: "reserved",
  },
  {
    href: `${V1_BASE}/service-calendar`,
    external: true,
    Icon: Calendar,
    name: "Service Calendar",
    tagline: "Bookings, leads, confirmations.",
    pillTone: "reserved",
  },
  {
    href: `${V1_BASE}/kpi/overview`,
    external: true,
    Icon: BarChart2,
    name: "KPI Dashboard",
    tagline: "The numbers, period over period.",
    pillTone: "reserved",
  },
  {
    href: `${V1_BASE}/playbook`,
    external: true,
    Icon: BookOpen,
    name: "Academy",
    tagline: "What every role should know.",
    pillTone: "reserved",
  },
];

const LIVE_COUNT = DOORS.filter((d) => d.pillTone === "live").length;
const TOTAL_COUNT = DOORS.length;

// Phone More-tools: the three tools the shell-level phone tab bar does NOT
// carry (Home / Stockpot / People / Ops / Menu). Service Calendar, KPI
// Dashboard and Academy need a surface on Home instead.
const MORE_TOOLS = DOORS.filter((d) =>
  ["Service Calendar", "KPI Dashboard", "Academy"].includes(d.name)
);

function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  if (!local) return "there";
  return local
    .split(".")
    .filter((p) => p.length > 0)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

export async function Home({ email }: { email: string }) {
  const client = serviceClient();
  const { data: userRow } = await client
    .from("pr_users")
    .select("name")
    .eq("email", email)
    .maybeSingle();
  const nameFromDb = (userRow as { name: string | null } | null)?.name ?? null;
  const displayName = nameFromDb && nameFromDb.length > 0 ? nameFromDb : nameFromEmail(email);

  const period = await currentPeriod();
  const todayLong = fmtDate(new Date().toISOString(), "long");

  return (
    <>
      <IdentBand
        eyebrow="One shell, every tool"
        title={`Welcome back, ${displayName}`}
        kick="Stockpot is live here. Everything else still runs on the current intranet."
        facts={[
          {
            label: "Tools in the new shell",
            value: String(LIVE_COUNT),
            note: `of ${TOTAL_COUNT}`,
          },
        ]}
      />

      <section className="kf-doors kf-only-desktop" aria-label="Tools">
        <ul className="kf-doors__grid">
          {DOORS.map(({ href, external, Icon, name, tagline, pillTone }, i) => (
            <li key={name} className="kf-reveal" style={{ ["--i" as never]: i + 1 }}>
              <Link
                href={href}
                className="kf-door"
                target={external ? "_self" : undefined}
                rel={external ? "noopener" : undefined}
              >
                <span className="kf-door__icon" aria-hidden>
                  <Icon size={24} strokeWidth={1.5} />
                </span>
                <div className="kf-door__body">
                  <h3 className="kf-door__title">{name}</h3>
                  <p className="kf-door__tagline">{tagline}</p>
                  {pillTone === "live" ? (
                    <span className="kf-pill kf-pill--live">Live</span>
                  ) : (
                    <span className="kf-meta">
                      <ExternalLink size={14} strokeWidth={1.5} />
                      <span>Opens on the current intranet</span>
                    </span>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="kf-phone-home kf-only-phone" aria-label="Home">
        <span className="kf-eyebrow kf-eyebrow--plain">{todayLong}</span>
        <h2 className="kf-phone-home__title">Welcome back, {displayName}</h2>
        <p className="kf-phone-home__kick">
          Stockpot is live here. Everything else still runs on the current intranet.
        </p>

        <div className="kf-phone-home__facts">
          <article className="kf-fact">
            <span className="kf-fact__label">Tools in the new shell</span>
            <span className="kf-fact__value">{LIVE_COUNT}</span>
            <span className="kf-fact__note">of {TOTAL_COUNT}</span>
          </article>
          <article className="kf-fact">
            <span className="kf-fact__label">Period</span>
            <span className="kf-fact__value">
              {period ? period.period_no : "-"}
            </span>
            <span className="kf-fact__note">
              {period ? `week ${period.week}` : "no fiscal row"}
            </span>
          </article>
        </div>

        <article className="kf-card kf-more-tools">
          <header>
            <span className="kf-eyebrow kf-eyebrow--plain">More tools</span>
            <h3>On the current intranet</h3>
          </header>
          <ul className="kf-more-tools__list">
            {MORE_TOOLS.map(({ href, Icon, name }) => (
              <li key={name}>
                <Link href={href} className="kf-more-tools__row" target="_self" rel="noopener">
                  <span className="kf-more-tools__icon" aria-hidden>
                    <Icon size={18} strokeWidth={1.5} />
                  </span>
                  <span className="kf-more-tools__name">{name}</span>
                  <ExternalLink size={14} strokeWidth={1.5} className="kf-more-tools__ext" />
                </Link>
              </li>
            ))}
          </ul>
        </article>
      </section>
    </>
  );
}
