// Loading state for /people. Skeleton rows match the roster's
// shape (32px avatar + two text lines + 120px flight slot).

import { Block, Line } from "@/components/ui/Skeleton";
import "./people.css";

export default function Loading() {
  return (
    <section className="kf-pe-roster" aria-label="Loading roster">
      <header className="kf-pe-roster__head">
        <h3>Loading your team</h3>
      </header>
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="kf-pe-skelrow">
          <Block height={32} width={32} radius={9999} />
          <Line width="70%" />
          <Line width="100px" />
        </div>
      ))}
    </section>
  );
}
