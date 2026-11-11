"use client";

// Item facts dl - vendor, item no., pack, billed unit, unit price,
// annual spend, annual lines, sites, last purchase, optional GTIN.
//
// Lifted verbatim from DetailPanel.tsx in N7 commit 0. Markup and
// classes unchanged.

import { fmtCount, fmtDate, fmtUsd, fmtUsdLong } from "@/lib/fmt";
import type { ReviewGroupItem } from "../itemTypes";

export function ItemFacts({ item }: { item: ReviewGroupItem }) {
  // P1 §5/§6: plain-English pack-origin label. Pre-P1 showed the raw
  // enum ("catalog", "invoice", "manually entered"); P1 broadens the
  // vocabulary to "from catalog (name match)" for trigram hits and
  // keeps the words plain. The checkChip shows alongside when the
  // pack is in check state (needs human verification) - the chip is
  // what distinguishes a check pack from an ok pack "at a glance"
  // per §6.
  const packSourceLabel =
    item.packSource === "override" ? "set by hand"
      : item.packSource === "catalog_sibling" ? "from same-vendor siblings"
        : item.packSource === "catalog"
          ? item.matchSource === "catalog_name"
            ? "from catalog (name match)"
            : "from catalog"
          : item.packSource === "invoice" ? "from invoice pack text"
            : null;
  const isCheck = item.packState === "check";
  const checkChipTitle =
    item.matchSource === "catalog_name" && item.matchScore != null
      ? `matched to a catalog row by name (trigram similarity ${item.matchScore.toFixed(2)}); verify this pack is right`
      : "pack needs human verification";
  return (
    <section className="kf-drawer__block" aria-label="Item facts">
      {item.displayNameSource === "catalog" && item.vendorOcrName !== item.displayName ? (
        <div className="kf-dpn__ocr" title="Vendor's invoice description (verbatim)">
          Invoice description: <span>{item.vendorOcrName}</span>
        </div>
      ) : null}
      <dl className="kf-facts">
        <div>
          <dt>Vendor</dt>
          <dd>{item.vendor}</dd>
        </div>
        <div>
          <dt>Vendor item no.</dt>
          <dd>{item.itemNumber ?? <span className="kf-muted">none</span>}</dd>
        </div>
        <div>
          <dt>Pack size</dt>
          <dd>
            {item.packNormalized ?? item.pack ?? <span className="kf-muted">-</span>}
            {packSourceLabel ? (
              <span className={`kf-facts__note${item.packSource === "override" ? " kf-facts__note--warn" : ""}`}>
                {packSourceLabel}
              </span>
            ) : null}
            {isCheck ? (
              <span className="kf-facts__chip kf-facts__chip--check" title={checkChipTitle}>
                Review
              </span>
            ) : null}
            {item.packNote ? (
              // Q2 §4: evidence-strength phrase from the P1/P2
              // backfill ("inferred from N similar items at this
              // vendor; verify"). Pre-Q2 the backfill wrote this and
              // nothing read it - 115 sibling-filled items were
              // flagged for review without a way to see HOW many
              // siblings backed each inference. Now it reads.
              <div className="kf-facts__packnote">{item.packNote}</div>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Billed unit</dt>
          <dd>{item.billedUnit ?? <span className="kf-muted">-</span>}</dd>
        </div>
        <div>
          <dt>Unit price</dt>
          <dd>
            {/* Headline = per-unit (always). Secondary = case price. */}
            {item.perBase != null && item.perBaseUom && item.perBaseConfidence ? (
              <>
                <strong>{fmtUsd(item.perBase)}</strong>
                <span className="kf-muted">
                  {" "}/ {item.perBaseUom === "LB" ? "lb"
                      : item.perBaseUom === "FLOZ" ? "fl oz"
                      : item.perBaseUom === "EA" ? "each"
                      : item.perBaseUom.toLowerCase()}
                </span>
                {item.perBaseConfidence === "override" ? (
                  <span className="kf-facts__note">override</span>
                ) : item.perBaseConfidence === "derived" ? (
                  <span className="kf-facts__note">from spend</span>
                ) : item.perBaseConfidence === "high" ? (
                  <span className="kf-facts__note">per-unit (high)</span>
                ) : (
                  <span className="kf-facts__note kf-facts__note--warn">est. (low)</span>
                )}
                {item.perBaseNote ? (
                  <div className="kf-cell-sub kf-cell-sub--dim">{item.perBaseNote}</div>
                ) : null}
              </>
            ) : (
              <>
                <strong className="kf-muted">- / unit</strong>
                <span className="kf-facts__note kf-facts__note--warn">needs pack</span>
              </>
            )}
            {item.catalogPrice != null ? (
              <div className="kf-cell-sub kf-cell-sub--dim">
                {fmtUsd(item.catalogPrice)} case (catalog)
              </div>
            ) : item.unitPrice != null ? (
              <div className="kf-cell-sub kf-cell-sub--dim">
                {fmtUsd(item.unitPrice)}
                {item.unitPriceUnit ? ` /${item.unitPriceUnit}` : ""} case (billed, latest)
              </div>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Annual spend</dt>
          <dd>${fmtUsdLong(item.usd12m).replace(/^\$/, "")}</dd>
        </div>
        <div>
          <dt>Annual lines</dt>
          <dd>{fmtCount(item.lines12m)}</dd>
        </div>
        <div>
          <dt>Sites</dt>
          <dd>
            {item.accounts.length > 0 ? (
              <span className="kf-site-pills">
                {item.accounts.map((c) => (
                  <span key={c} className="kf-site-pill">{c}</span>
                ))}
              </span>
            ) : (
              <span className="kf-muted">-</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Last purchase</dt>
          <dd>{item.lastSeen ? fmtDate(item.lastSeen) : <span className="kf-muted">-</span>}</dd>
        </div>
        {item.gtin ? (
          <div>
            <dt>GTIN</dt>
            <dd className="kf-dpn__gtin">{item.gtin}</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}
