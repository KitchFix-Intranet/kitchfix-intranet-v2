import { ExternalIntranetLink } from "@/components/shell/ExternalIntranetLink";

// T2.3 item 13 (2026-11-13). The link crushes the topbar's page
// title to "MY..." at 390. Hide it on phone; it stays on desktop
// where the title has room.
export default function Page() {
  return (
    <span className="kf-only-desktop">
      <ExternalIntranetLink tool="people" />
    </span>
  );
}
