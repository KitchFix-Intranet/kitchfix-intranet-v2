import { ExternalIntranetLink } from "@/components/shell/ExternalIntranetLink";

// T4a (2026-11-13). Same topbar as /people and /people/inbox.
export default function Page() {
  return (
    <span className="kf-only-desktop">
      <ExternalIntranetLink tool="people" />
    </span>
  );
}
