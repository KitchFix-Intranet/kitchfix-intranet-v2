// Invoices list surface - the composer. Server component.
// Renders:
//   - optional OwnerPreviewBanner
//   - HeadBand (desktop) + PhoneHead (phone), both server-rendered;
//     CSS controls which is visible at which width
//   - Toolbar (client; owns its own handlers + status help dialog)
//   - List content: table + stacked cards, both server-rendered,
//     CSS @container swaps visibility. One empty-state is picked
//     when the content area has nothing to show.
//   - ShowOlder link (server)
//   - Drawer (client), conditional on detail being present
//
// All URL building goes through hrefs.ts so client and server stay
// in sync.

import type { Viewer } from "@/lib/people/types";
import type { DetailRowView, FilterKey, InvoiceScope, SiteNavItem } from "@/lib/invoices/types";
import type { ListView } from "@/lib/invoices/load";
import { HeadBand } from "./HeadBand";
import { PhoneHead } from "./PhoneHead";
import { Toolbar } from "./Toolbar";
import { InvoiceTable } from "./InvoiceTable";
import { StackedCards } from "./StackedCards";
import { Drawer } from "./Drawer";
import { ShowOlder } from "./ShowOlder";
import { OwnerPreviewBanner } from "./OwnerPreviewBanner";
import { NothingYet, NothingMatches, NothingToFix } from "./EmptyStates";
import { buildDrawerCloseHref, buildDrawerOpenHref, buildListHref } from "./hrefs";

export function InvoicesSurface({
  viewer,
  scope,
  sites,
  site,
  show,
  q,
  inv,
  more,
  asParam,
  previewName,
  listView,
  invDetail,
  period,
  manySites,
}: {
  viewer: Viewer;
  scope: InvoiceScope;
  sites: readonly SiteNavItem[];
  site: string | null;
  show: FilterKey;
  q: string | null;
  inv: string | null;
  more: number;
  asParam: string | null;
  previewName: string | null;
  listView: ListView;
  invDetail: DetailRowView | null;
  period: { period_no: number; week: number } | null;
  manySites: boolean;
}) {
  const siteNavItem = site ? sites.find((s) => s.accountKey === site) ?? null : null;
  const singleSiteName = siteNavItem?.accountKey ?? (sites.length === 1 ? sites[0].accountKey : null);

  const eyebrow = (() => {
    const periodBit = period ? `Period ${period.period_no}, week ${period.week}` : "";
    if (siteNavItem) return periodBit ? `${siteNavItem.accountKey} · ${periodBit}` : siteNavItem.accountKey;
    if (!manySites && sites[0]) return periodBit ? `${sites[0].accountKey} · ${periodBit}` : sites[0].accountKey;
    const scopeLabel = scope.kind === "regional_director" ? "My region" : "All sites";
    return periodBit ? `${scopeLabel} · ${periodBit}` : scopeLabel;
  })();

  const showFixHref = buildListHref({ show: "fix", q, site, inv: null, more: 1, asParam });
  const showAllHref = buildListHref({ show: "all", q: null, site: null, inv: null, more: 1, asParam });
  const moreHref = listView.rows.length < listView.total
    ? buildListHref({ show, q, site, inv, more: more + 1, asParam })
    : null;

  const anyFilter = show !== "all" || !!q || !!site;

  const fixWord = scope.words.fix;
  const openHref = (id: string) =>
    buildDrawerOpenHref({ show, q, site, more, asParam, invId: id });

  const emptyState = (() => {
    if (listView.rows.length > 0) return null;
    if (show === "fix") return <NothingToFix fixWord={fixWord} />;
    if (anyFilter) return <NothingMatches fixWord={fixWord} clearHref={showAllHref} />;
    return <NothingYet siteName={singleSiteName} />;
  })();

  const drawerCloseHref = buildDrawerCloseHref({ show, q, site, more, asParam });

  return (
    <div className={`kf-invoices-surface ${manySites ? "is-manysites" : "is-onesite"}`}>
      {previewName ? <OwnerPreviewBanner name={previewName} exitHref="/invoices/list" /> : null}

      <HeadBand
        scope={scope}
        listView={listView}
        eyebrow={eyebrow}
        showFixHref={showFixHref}
        manySites={manySites}
        singleSiteName={singleSiteName}
      />
      <PhoneHead
        scope={scope}
        listView={listView}
        manySites={manySites}
        singleSiteName={singleSiteName}
      />

      <Toolbar
        show={show}
        q={q}
        site={site}
        inv={inv}
        manySites={manySites}
        sites={sites}
        chipCounts={listView.chipCounts}
        siteFixCounts={listView.siteFixCounts}
        fixWord={fixWord}
        asParam={asParam}
      />

      <div className="kf-invoices-list" aria-live="polite">
        {emptyState ? emptyState : (
          <>
            <InvoiceTable
              rows={listView.rows}
              manySites={manySites}
              sites={sites}
              fixWord={fixWord}
              openHref={openHref}
            />
            <StackedCards
              rows={listView.rows}
              manySites={manySites}
              sites={sites}
              fixWord={fixWord}
              openHref={openHref}
            />
          </>
        )}
      </div>

      <ShowOlder
        shown={listView.rows.length}
        total={listView.total}
        moreHref={listView.capHit ? null : moreHref}
        anyFilter={anyFilter}
        capHit={listView.capHit}
      />

      {invDetail ? (
        <Drawer
          detail={invDetail}
          siteLabel={invDetail.accountKey}
          closeHref={drawerCloseHref}
          fixWord={fixWord}
          invId={invDetail.id}
        />
      ) : null}
    </div>
  );
}
