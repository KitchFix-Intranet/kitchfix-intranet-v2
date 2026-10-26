import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { IdentBand } from "@/components/ui/IdentBand";
import "./reserved.css";

export type ReservedTool = "people" | "ops" | "service" | "kpi" | "academy";

const V1_BASE = "https://kitchfix-intranet.vercel.app";
const V1_URLS: Record<ReservedTool, string> = {
  people: "/people",
  ops: "/ops",
  service: "/service-calendar",
  kpi: "/kpi/overview",
  academy: "/playbook",
};
const NAMES: Record<ReservedTool, string> = {
  people: "People Portal",
  ops: "Ops Hub",
  service: "Service Calendar",
  kpi: "KPI Dashboard",
  academy: "Academy",
};

export function ReservedDoor({ slug, one_line }: { slug: ReservedTool; one_line: string }) {
  const name = NAMES[slug];
  const href = `${V1_BASE}${V1_URLS[slug]}`;
  return (
    <>
      <IdentBand eyebrow="KitchFix" title={name} kick={one_line} />
      <section className="kf-reserved kf-reveal" style={{ ["--i" as never]: 1 }}>
        <article className="kf-card kf-reserved__card">
          <header>
            <span className="kf-pill kf-pill--info">Runs on the current intranet</span>
          </header>
          <p className="kf-reserved__body">
            {one_line} The link below opens the current intranet in this tab;
            come back to KitchFix when you&rsquo;re done.
          </p>
          <footer className="kf-card__foot">
            <Link href={href} target="_self" rel="noopener" className="kf-btn kf-btn--line kf-btn--sm">
              <span>Open {name}</span>
              <ExternalLink size={14} strokeWidth={1.5} />
            </Link>
          </footer>
        </article>
      </section>
    </>
  );
}
