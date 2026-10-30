// /academy/team loading. Header + 8 row placeholders matched to the
// final list layout.
import { Block } from "@/components/ui/Skeleton";
import "@/components/academy/admin/admin.css";
import "@/components/academy/team/team.css";

export default function Loading() {
  return (
    <div className="kf-admin">
      <div className="kf-admin__head">
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-sp-2)" }}>
          <Block height={14} width={120} />
          <Block height={24} width={160} />
          <Block height={12} width={300} />
        </div>
        <Block height={36} width={220} radius={10} />
      </div>
      <div className="kf-ppl" aria-hidden>
        <Block height={44} radius={0} />
        <Block height={44} radius={0} />
        <Block height={44} radius={0} />
        <Block height={44} radius={0} />
        <Block height={44} radius={0} />
        <Block height={44} radius={0} />
      </div>
    </div>
  );
}
