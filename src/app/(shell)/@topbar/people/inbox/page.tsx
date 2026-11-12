import { ExternalIntranetLink } from "@/components/shell/ExternalIntranetLink";

// T3 (2026-11-13). Same topbar as /people: link to v1 stays on
// desktop, hidden on phone so it does not crush the title.
export default function Page() {
  return (
    <span className="kf-only-desktop">
      <ExternalIntranetLink tool="people" />
    </span>
  );
}
