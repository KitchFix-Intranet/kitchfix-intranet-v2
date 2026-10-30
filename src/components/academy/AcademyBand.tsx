// F1 band for the learner surfaces. Standalone - the shared IdentBand
// stays untouched because other sections rely on its exact behaviour.
// This band stretches the full canvas (R-AC25), carries a facts strip
// with count-up numbers, and matches the V7 render frame. CSS lives
// in src/components/academy/academy.css under .kf-aband*.
//
// Note on hiding at phone: the whole band is display:none at <=860,
// matching the shared IdentBand's kf-only-desktop behaviour. The
// learner pages render a .kf-pstatus below for the phone.

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { CountUp } from "./CountUp";

export type AcademyBandFact = {
  label: string;
  // When value is a number we animate it on mount; a string renders
  // as-is (dates, labels).
  value: number | string;
  // Optional unit next to the number ("min", "N" dropped).
  unit?: string;
};

type Props = {
  eyebrow: string;
  title: string;
  kick?: string;
  facts?: AcademyBandFact[];
  cta?: { label: string; href: string };
  // Optional on-navy action slot for pages whose CTA needs client
  // interactivity (clipboard copy, dialog trigger) that a Link cannot
  // express. When provided, it renders inside .kf-aband__cta in place
  // of the Link; learner pages pass no actionSlot so their rendering
  // is byte-identical.
  actionSlot?: React.ReactNode;
};

export function AcademyBand({ eyebrow, title, kick, facts, cta, actionSlot }: Props) {
  const trimmedFacts = (facts ?? []).slice(0, 3);
  const hasAction = !!(actionSlot || cta);
  return (
    <section className="kf-aband kf-band kf-only-desktop kf-reveal" aria-label="Overview">
      <div className="kf-aband__sheen" aria-hidden />
      <div className="kf-aband__left">
        <span className="kf-eyebrow">{eyebrow}</span>
        <h2 className="kf-aband__title">{title}</h2>
        {kick ? <p className="kf-aband__kick">{kick}</p> : null}
      </div>
      {trimmedFacts.length > 0 || hasAction ? (
        <div className="kf-aband__right">
          {trimmedFacts.map((f, i) => (
            <div key={`${f.label}-${i}`} className="kf-aband-fact">
              <span className="kf-aband-fact__label">{f.label}</span>
              <span className="kf-aband-fact__value">
                {typeof f.value === "number"
                  ? <CountUp value={f.value} />
                  : <span>{f.value}</span>}
                {f.unit ? <span className="kf-aband-fact__unit">{f.unit}</span> : null}
              </span>
            </div>
          ))}
          {actionSlot ? (
            <div className="kf-aband__cta">{actionSlot}</div>
          ) : cta ? (
            <div className="kf-aband__cta">
              <Link href={cta.href} className="kf-btn kf-btn--on-navy">
                {cta.label}
                <ArrowRight size={16} strokeWidth={1.5} />
              </Link>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
