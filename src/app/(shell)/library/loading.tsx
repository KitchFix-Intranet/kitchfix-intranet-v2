// /library loading. D2 landing surface is Find - band + search field
// placeholder + a few result-row-shaped blocks. Matches the final
// Find layout; the moved D1 Shelves loading lives at
// /library/shelves/loading.tsx.
import { Band, Block } from "@/components/ui/Skeleton";
import "@/components/library/library.css";

export default function Loading() {
  return (
    <div className="kf-library">
      <div className="kf-only-desktop">
        <Band />
      </div>
      <div className="kf-find">
        <Block height={56} radius={12} />
        <Block height={56} />
        <Block height={56} />
        <Block height={56} />
        <Block height={56} />
      </div>
    </div>
  );
}
