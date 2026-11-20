// Train 2b correction F4 / correction 9: /invoices serves both the
// landing and a sitting, and loading.tsx cannot see `?draft=`. So
// this file renders the landing's skeleton only - the sitting path
// has its own Suspense boundary inside page.tsx that renders the
// sitting skeleton for that branch.

import { Band, Block, Line } from "@/components/ui/Skeleton";
import "@/components/invoices/invoices.css";
import "@/components/invoices/capture.css";

export default function Loading() {
  return (
    <div className="kf-invoices-surface kf-inv-capture" role="status" aria-busy="true">
      <div className="kf-only-desktop">
        <Band />
      </div>
      <div className="kf-inv-phonehead kf-only-phone">
        <Line width="60%" />
        <Line width="80%" />
      </div>

      <Block height={160} />

      <div className="kf-inv-landing-grid kf-only-desktop">
        <Block height={200} />
        <Block height={200} />
      </div>
      <div className="kf-inv-landing-stack kf-only-phone">
        <Block height={200} />
      </div>

      <section className="kf-inv-capture__pane">
        <h3>Drafts waiting</h3>
        <Block height={48} />
        <Block height={48} />
      </section>
    </div>
  );
}
