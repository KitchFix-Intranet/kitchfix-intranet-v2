// Skeleton for /service. Heights match the real rendered content so
// the page does not jump on load.

import { Band, Block, Line } from "@/components/ui/Skeleton";
import "./service.css";

export default function Loading() {
  return (
    <div className="kf-sc-surface" aria-label="Loading the calendar">
      <Band />
      <section className="kf-sc-stage" aria-hidden>
        <header className="kf-sc-stage__head">
          <div className="kf-sc-stage__titles">
            <Line width="140px" />
            <Line width="260px" />
          </div>
        </header>
        {Array.from({ length: 4 }).map((_, w) => (
          <article key={w} className="kf-sc-skel-wk">
            <Line width="200px" />
            <div className="kf-sc-skel-row">
              {Array.from({ length: 7 }).map((__, d) => (
                <Block key={d} height={112} radius={14} />
              ))}
            </div>
          </article>
        ))}
      </section>
      <section className="kf-sc-yearsec" aria-hidden>
        <header className="kf-sc-yearsec__head">
          <Line width="180px" />
        </header>
        <div className="kf-sc-skel-year">
          {Array.from({ length: 13 }).map((_, i) => (
            <Block key={i} height={128} radius={14} />
          ))}
        </div>
      </section>
    </div>
  );
}
