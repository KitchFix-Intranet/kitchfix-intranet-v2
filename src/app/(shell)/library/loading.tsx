// /library loading. Band + two-column shape (shelf list on the left,
// doc rows on the right) matched to the final layout.
import { Band, Block } from "@/components/ui/Skeleton";
import "@/components/library/library.css";

export default function Loading() {
  return (
    <div className="kf-library">
      <div className="kf-only-desktop">
        <Band />
      </div>
      <div className="kf-library__grid">
        <div className="kf-library__shelves">
          <Block height={44} radius={10} />
          <Block height={44} radius={10} />
          <Block height={44} radius={10} />
          <Block height={44} radius={10} />
          <Block height={44} radius={10} />
          <Block height={44} radius={10} />
        </div>
        <div className="kf-library__shelf-pane">
          <Block height={28} width={240} />
          <Block height={56} />
          <Block height={56} />
          <Block height={56} />
          <Block height={56} />
        </div>
      </div>
    </div>
  );
}
