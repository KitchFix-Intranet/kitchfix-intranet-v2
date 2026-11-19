// /library loading. Shape-matched to the bookcase: band + search +
// shelf-list rail + a few tile blocks.
import { Band, Block } from "@/components/ui/Skeleton";
import "@/components/library/library.css";

export default function Loading() {
  return (
    <div className="kf-library">
      <div className="kf-only-desktop">
        <Band />
      </div>
      <div className="kf-lb-tools">
        <Block height={48} radius={12} />
      </div>
      <div className="kf-lb-lay">
        <aside className="kf-lb-rail kf-only-desktop" aria-hidden>
          <div className="kf-lb-rail__inner">
            <Block height={40} radius={10} />
            <Block height={40} radius={10} />
            <Block height={40} radius={10} />
            <Block height={40} radius={10} />
            <Block height={40} radius={10} />
            <Block height={40} radius={10} />
          </div>
        </aside>
        <main className="kf-lb-main">
          <Block height={28} width={240} />
          <Block height={140} radius={14} />
          <Block height={140} radius={14} />
          <Block height={140} radius={14} />
        </main>
      </div>
    </div>
  );
}
