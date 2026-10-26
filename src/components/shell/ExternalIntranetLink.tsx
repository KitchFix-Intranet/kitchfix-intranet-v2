import Link from "next/link";
import { ExternalLink } from "lucide-react";

type ToolSlug = "people" | "ops" | "service" | "kpi" | "academy";
const V1_BASE = "https://kitchfix-intranet.vercel.app";
const V1_URLS: Record<ToolSlug, string> = {
  people: "/people",
  ops: "/ops",
  service: "/service-calendar",
  kpi: "/kpi/overview",
  academy: "/playbook",
};
const LABELS: Record<ToolSlug, string> = {
  people: "People Portal",
  ops: "Ops Hub",
  service: "Service Calendar",
  kpi: "KPI Dashboard",
  academy: "Academy",
};

export function ExternalIntranetLink({ tool }: { tool: ToolSlug }) {
  return (
    <Link
      href={`${V1_BASE}${V1_URLS[tool]}`}
      className="kf-btn kf-btn--line kf-btn--sm"
      target="_self"
      rel="noopener"
    >
      <span>Open {LABELS[tool]}</span>
      <ExternalLink size={14} strokeWidth={1.5} />
    </Link>
  );
}
