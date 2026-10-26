// One group card. Server-rendered; interactive bits are in the ReviewActions
// client island (so no function props cross the RSC boundary).

import { Scale } from "lucide-react";
import { fmtCount, fmtDate, fmtUsd, fmtUsdLong } from "@/lib/fmt";
import { ReviewActions, type ReviewMemberItem } from "./ReviewActions";

export type ReviewGroupItem = {
  id: string;
  name: string;
  vendor: string;
  itemNumber: string | null;
  pack: string | null;
  billedUnit: string | null;
  usd12m: number;
  lines12m: number;
  accountsCount: number;
  lastSeen: string | null;
  confidence: string | null;
  reason: string;
  catchWeight: boolean;
};

export type ReviewCardGroup = {
  key: string;
  kind: "existing" | "new";
  ingredient: { id: string; name: string; parent: string | null } | null;
  proposedName: string | null;
  proposedParent: string | null;
  totalUsd12m: number;
  totalLines12m: number;
  items: ReviewGroupItem[];
};

export function ReviewCard({
  group,
  ingredients,
}: {
  group: ReviewCardGroup;
  ingredients: Array<{ id: string; name: string; parent: string | null }>;
}) {
  const title = group.kind === "existing" ? group.ingredient?.name ?? "Unknown" : group.proposedName ?? "New ingredient";
  const parent = group.kind === "existing" ? group.ingredient?.parent ?? null : group.proposedParent;
  const hasLow = group.items.some((it) => it.confidence === "low");

  const memberItems: ReviewMemberItem[] = group.items.map((it) => ({
    id: it.id,
    name: it.name,
    confidence: it.confidence,
  }));

  return (
    <article className={`kf-rvc${group.kind === "new" ? " kf-rvc--new" : ""}`}>
      <header className="kf-rvc__head">
        <div className="kf-rvc__title-wrap">
          <span className={`kf-pill ${group.kind === "new" ? "kf-pill--warn" : "kf-pill--info"}`}>
            {group.kind === "new" ? "New ingredient" : "Existing match"}
          </span>
          {hasLow ? <span className="kf-pill kf-pill--muted">Low confidence inside</span> : null}
          <h3 className="kf-rvc__title">{title}</h3>
          {parent ? <span className="kf-rvc__parent">{parent}</span> : null}
        </div>
        <div className="kf-rvc__totals">
          <strong>{fmtUsdLong(group.totalUsd12m)}</strong>
          <span>{fmtCount(group.totalLines12m)} lines / {fmtCount(group.items.length)} items</span>
        </div>
      </header>

      <table className="kf-rvc__items">
        <thead>
          <tr>
            <th>Item</th>
            <th>Vendor / #</th>
            <th>Pack / unit</th>
            <th className="kf-table__num">12m $</th>
            <th className="kf-table__num">Lines</th>
            <th>Sites</th>
            <th>Last seen</th>
            <th>Conf</th>
          </tr>
        </thead>
        <tbody>
          {group.items.map((it) => (
            <tr key={it.id}>
              <td title={it.name}>
                <div className="kf-rvc__desc">
                  <span className="kf-cell-ellipsis">{it.name}</span>
                  {it.catchWeight ? (
                    <span className="kf-flag kf-flag--warn" title="Priced by actual weight">
                      <Scale size={14} strokeWidth={1.5} />
                    </span>
                  ) : null}
                </div>
                {it.reason ? <div className="kf-rvc__reason">{it.reason}</div> : null}
              </td>
              <td>
                <div className="kf-cell-strong kf-cell-ellipsis">{it.vendor}</div>
                <div className="kf-cell-sub">{it.itemNumber ?? "none"}</div>
              </td>
              <td>
                <div className="kf-cell-ellipsis">
                  {it.pack ?? "-"}
                  <span className="kf-muted"> / {it.billedUnit ?? "-"}</span>
                </div>
              </td>
              <td className="kf-table__num"><strong>${fmtUsdLong(it.usd12m).replace(/^\$/, "")}</strong></td>
              <td className="kf-table__num">{fmtCount(it.lines12m)}</td>
              <td>{it.accountsCount}</td>
              <td>{it.lastSeen ? fmtDate(it.lastSeen) : "-"}</td>
              <td><ConfidenceChip c={it.confidence} /></td>
            </tr>
          ))}
        </tbody>
      </table>

      <ReviewActions
        groupKey={group.key}
        kind={group.kind}
        currentIngredientId={group.ingredient?.id ?? null}
        proposedName={group.proposedName}
        proposedParent={group.proposedParent}
        memberItems={memberItems}
        ingredients={ingredients}
      />

      <footer className="kf-rvc__foot">
        {fmtUsd(group.totalUsd12m)} will move to Linked when every item here is confirmed.
      </footer>
    </article>
  );
}

function ConfidenceChip({ c }: { c: string | null }) {
  if (c === "high") return <span className="kf-pill kf-pill--good">High</span>;
  if (c === "med") return <span className="kf-pill kf-pill--info">Med</span>;
  if (c === "low") return <span className="kf-pill kf-pill--muted">Low</span>;
  return <span className="kf-pill kf-pill--muted">-</span>;
}
