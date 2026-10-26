// /library/[docId] loading. Pane body + facts rail, matched to the
// final layout.
import { Block } from "@/components/ui/Skeleton";
import "@/components/academy/academy.css";
import "@/components/library/library.css";

export default function Loading() {
  return (
    <div className="kf-docview">
      <div className="kf-reader kf-docview__pane">
        <div className="kf-reader__head">
          <Block height={28} width={280} />
        </div>
        <div className="kf-reader__body">
          <Block height={120} />
          <Block height={200} />
          <Block height={200} />
        </div>
      </div>
      <div className="kf-docfacts">
        <Block height={28} width={160} />
        <Block height={200} />
        <Block height={48} />
      </div>
    </div>
  );
}
