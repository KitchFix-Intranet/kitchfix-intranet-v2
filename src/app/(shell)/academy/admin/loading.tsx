// /academy/admin loading. Header block + a few cycle-row-shaped
// placeholders matched to the final layout.
import { Block } from "@/components/ui/Skeleton";
import "@/components/academy/admin/admin.css";

export default function Loading() {
  return (
    <div className="kf-admin">
      <div className="kf-admin__head">
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-sp-2)" }}>
          <Block height={14} width={120} />
          <Block height={24} width={180} />
          <Block height={12} width={320} />
        </div>
        <Block height={36} width={120} radius={10} />
      </div>
      <div className="kf-cycles">
        <Block height={56} radius={0} />
        <Block height={56} radius={0} />
        <Block height={56} radius={0} />
      </div>
    </div>
  );
}
