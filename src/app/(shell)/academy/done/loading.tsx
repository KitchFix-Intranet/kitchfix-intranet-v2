// /academy/done loading. Band + three receipt-shaped placeholders.
import { Band, Block } from "@/components/ui/Skeleton";
import "@/components/academy/academy.css";

export default function Loading() {
  return (
    <div className="kf-sheet">
      <div className="kf-only-desktop">
        <Band />
      </div>
      <Block height={140} />
      <Block height={140} />
      <Block height={140} />
    </div>
  );
}
