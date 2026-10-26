import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { KickInfoButton } from "./KickInfoButton";
import { BandRetryButton } from "./BandRetryButton";
import { RunningWatch } from "./RunningWatch";
import { timeAgo } from "@/lib/fmt";
import "./ident.css";

export type BandFact = {
  label: string;
  value: string;
  note?: string;
  tone?: "ok" | "running" | "warn" | "muted";
};

export type BandCta = { label: string; href: string };

export type BandStatus = "ok" | "failed" | "running";

type Props = {
  eyebrow: string;
  title: string;
  kick: string;
  kickInfo?: React.ReactNode;
  facts?: BandFact[];
  cta?: BandCta;
  status?: BandStatus;
  // For the running / stalled state the newest run's started_at.
  runningStartedAt?: string | null;
  // Fallback headline when `failed` renders. The topbar owns the page title;
  // only the failure state uses a page-name headline inside the band.
  pageName?: string;
};

const KICK_MAX = 60;

function factToneClass(tone?: BandFact["tone"]): string {
  switch (tone) {
    case "running": return "kf-band-fact--running";
    case "warn":    return "kf-band-fact--warn";
    case "muted":   return "kf-band-fact--muted";
    default:        return "";
  }
}

export function IdentBand({
  eyebrow,
  title,
  kick,
  kickInfo,
  facts,
  cta,
  status = "ok",
  runningStartedAt,
  pageName,
}: Props) {
  if (process.env.NODE_ENV !== "production" && kick.length > KICK_MAX) {
    // eslint-disable-next-line no-console
    console.warn(`IdentBand: kick is ${kick.length} chars, max ${KICK_MAX}: "${kick}"`);
  }

  const trimmed = (facts ?? []).slice(0, 2);
  let resolvedTitle = title;
  let resolvedFacts: BandFact[] = trimmed;
  const extraWatch = status === "running";
  let stalled = false;

  if (status === "failed") {
    resolvedTitle = pageName ?? title;
    resolvedFacts = [
      { label: "Status", value: "Unavailable", note: "Couldn't read intake status", tone: "warn" },
    ];
  } else if (status === "running" && runningStartedAt) {
    const minutes = (Date.now() - Date.parse(runningStartedAt)) / 60000;
    stalled = Number.isFinite(minutes) && minutes >= 15;
    resolvedFacts = [
      stalled
        ? { label: "Status", value: "Stalled", note: `started ${timeAgo(runningStartedAt)}`, tone: "warn" }
        : { label: "Status", value: "Running", note: `started ${timeAgo(runningStartedAt)} - about 3 min`, tone: "running" },
    ];
  }

  return (
    <section className="kf-band kf-only-desktop kf-reveal" style={{ ["--i" as never]: 0 }} aria-label="Overview">
      <div className="kf-band__frame">
        <div className="kf-band__sheen" aria-hidden />
        <div className="kf-band__left">
          <span className="kf-eyebrow kf-band__eyebrow">{eyebrow}</span>
          <h2 className="kf-band__title">{resolvedTitle}</h2>
          <p className="kf-band__kick">
            <span className="kf-band__kick-text">{kick}</span>
            {kickInfo ? <KickInfoButton>{kickInfo}</KickInfoButton> : null}
          </p>
        </div>

        {resolvedFacts.length > 0 || cta || status === "failed" ? (
          <div className="kf-band__right">
            {resolvedFacts.map((f, i) => (
              <div key={`${f.label}-${i}`} className={`kf-band-fact ${factToneClass(f.tone)}`}>
                <span className="kf-band-fact__label">{f.label}</span>
                <span className="kf-band-fact__value">
                  {f.tone === "running" && !stalled ? <span className="kf-band-fact__dot" aria-hidden /> : null}
                  {f.value}
                </span>
                {f.note ? <span className="kf-band-fact__note">{f.note}</span> : null}
              </div>
            ))}

            {status === "failed" ? (
              <div className="kf-band__cta">
                <BandRetryButton />
              </div>
            ) : cta ? (
              <div className="kf-band__cta">
                <Link href={cta.href} className="kf-btn kf-btn--on-navy">
                  {cta.label}
                  <ArrowRight size={16} strokeWidth={1.5} />
                </Link>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <RunningWatch enabled={extraWatch} />
    </section>
  );
}
