// /academy/done loading. Shape-matched: band 128, three receipt
// cards at 104, plus the Your-year + What-a-cert-proves rail cards.
import { Block } from "@/components/ui/Skeleton";
import "@/components/academy/academy.css";

export default function Loading() {
  return (
    <div className="kf-academy">
      <div className="kf-academy__wash" aria-hidden />
      <div className="kf-only-desktop">
        <Block height={128} radius={12} />
      </div>
      <div className="kf-academy__frame">
        <div className="kf-academy__main" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Block height={104} radius={12} />
          <Block height={104} radius={12} />
          <Block height={104} radius={12} />
        </div>
        <aside className="kf-academy__rail" aria-hidden>
          <Block height={168} radius={12} />
          <Block height={112} radius={12} />
        </aside>
      </div>
    </div>
  );
}
