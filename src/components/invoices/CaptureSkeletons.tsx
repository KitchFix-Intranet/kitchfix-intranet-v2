// Train 2b fix-before-push #6 / F4: one skeleton per Suspense
// boundary, chosen in page.tsx by inspecting `?draft=`. No
// /invoices/loading.tsx segment-level fallback - loading.tsx
// cannot see searchParams, so a sitting load would flash the
// landing skeleton. Instead, page.tsx reads searchParams at the
// top and wraps each branch in a Suspense with the right
// skeleton.
//
// Server component. Pure markup. Uses the shared Skeleton
// primitives so widths and colours stay in token.

import { Band, Block, Line } from "@/components/ui/Skeleton";

export function LandingSkeleton() {
  return (
    <div className="kf-invoices-surface kf-inv-capture" role="status" aria-busy="true">
      <div className="kf-only-desktop"><Band /></div>
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

export function SittingSkeleton() {
  return (
    <div className="kf-invoices-surface kf-inv-sitting-wrap" role="status" aria-busy="true">
      {/* Top row: Back + site + pager + "..." */}
      <div className="kf-inv-sitting__nav kf-only-desktop">
        <div className="kf-inv-sitting__nav__left">
          <Block height={40} width={88} />
          <Line width={200} />
        </div>
        <div className="kf-inv-sitting__nav__right">
          <Block height={40} width={160} />
        </div>
      </div>
      <div className="kf-inv-sitting__phonehead kf-only-phone">
        <div className="kf-inv-sitting__phonehead__row">
          <Block height={48} width={48} />
          <div className="kf-inv-sitting__phonehead__labels">
            <Line width="40%" />
            <Line width="70%" />
          </div>
          <Block height={48} width={48} />
        </div>
      </div>

      <div className="kf-inv-sitting">
        {/* Page column */}
        <section className="kf-inv-sitting__page">
          <div className="kf-inv-sitting__page-tools">
            <Line width="40%" />
          </div>
          <Block height={360} />
        </section>

        {/* Form column */}
        <section className="kf-inv-sitting__form">
          <Line width="30%" />
          <Block height={48} />
          <Block height={48} />
          <Block height={48} />
          <Block height={48} />
          <Line width="40%" />
          <Block height={96} />
          <Block height={48} />
        </section>
      </div>
    </div>
  );
}
