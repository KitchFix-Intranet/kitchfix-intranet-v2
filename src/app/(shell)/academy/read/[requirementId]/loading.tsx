// /academy/read/[id] loading. Shape-matched to the V7 reader: the
// 252px sections rail at left + the reader pane at right (head 60,
// a tall body block, foot 60). At <=1180 the rail hides.
import { Block } from "@/components/ui/Skeleton";
import "@/components/academy/academy.css";

export default function Loading() {
  return (
    <div className="kf-sheet kf-reader-layout">
      <aside className="kf-reader-rail" aria-hidden>
        <Block height={44} radius={8} />
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 12 }}>
          <Block height={44} radius={8} />
          <Block height={44} radius={8} />
          <Block height={44} radius={8} />
          <Block height={44} radius={8} />
          <Block height={44} radius={8} />
          <Block height={44} radius={8} />
        </div>
      </aside>
      <section className="kf-reader" aria-hidden>
        <Block height={60} radius={0} />
        <Block height={420} radius={0} />
        <Block height={60} radius={0} />
      </section>
    </div>
  );
}
