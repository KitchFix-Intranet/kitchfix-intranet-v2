// /academy loading. Shape-matched to the V7 layout at final heights:
// 128 band, 102 hero card, 72 row list, 168 + 112 rail cards.
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
        <div className="kf-academy__main">
          <Block height={102} radius={12} />
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <Block height={72} radius={12} />
            <Block height={72} radius={0} />
            <Block height={72} radius={0} />
          </div>
        </div>
        <aside className="kf-academy__rail" aria-hidden>
          <Block height={168} radius={12} />
          <Block height={112} radius={12} />
        </aside>
      </div>
    </div>
  );
}
