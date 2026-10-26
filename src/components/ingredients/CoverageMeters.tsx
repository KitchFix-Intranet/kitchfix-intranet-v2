// Two-layer meter rows: a "share" layer (this row's food dollars / the max
// food dollars in the list) and a "linked" layer (linked dollars / this
// row's food dollars). Both animate scaleX from the left on load with a
// per-row 40ms stagger.

import { fmtUsd } from "@/lib/fmt";

export type MeterRow = { name: string; food: number; linked: number };

function pct(num: number, den: number): string {
  if (den <= 0) return "0%";
  return `${Math.round((num / den) * 100)}%`;
}

const PHONE_LIMIT = 4;

export function CoverageMeters({ rows }: { rows: MeterRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="kf-empty">
        <div className="kf-empty__title">No food dollars yet</div>
        <div className="kf-empty__body">Run intake and the meters will fill.</div>
      </div>
    );
  }

  const maxFood = rows.reduce((m, r) => (r.food > m ? r.food : m), 0);

  return (
    <>
      <ul className="kf-meters kf-only-desktop">
        {rows.map((r, i) => (
          <li key={r.name} style={{ ["--i" as never]: i }}>
            <MeterRow row={r} maxFood={maxFood} />
          </li>
        ))}
      </ul>
      <ul className="kf-meters kf-only-phone kf-meters--collapsed">
        {rows.slice(0, PHONE_LIMIT).map((r, i) => (
          <li key={r.name} style={{ ["--i" as never]: i }}>
            <MeterRow row={r} maxFood={maxFood} />
          </li>
        ))}
      </ul>
      {rows.length > PHONE_LIMIT ? (
        <details className="kf-only-phone kf-meters__more">
          <summary>See all ({rows.length})</summary>
          <ul className="kf-meters">
            {rows.slice(PHONE_LIMIT).map((r, i) => (
              <li key={r.name} style={{ ["--i" as never]: i + PHONE_LIMIT }}>
                <MeterRow row={r} maxFood={maxFood} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

function MeterRow({ row, maxFood }: { row: MeterRow; maxFood: number }) {
  const shareWidth = pct(row.food, maxFood);
  const linkedWidth = row.linked > 0 ? pct(row.linked, row.food) : "0%";
  return (
    <div className="kf-meter">
      <span className="kf-meter__name" title={row.name}>{row.name}</span>
      <div className="kf-meter__bar">
        <div className="kf-meter__share" style={{ width: shareWidth }} />
        <div className="kf-meter__linked" style={{ width: linkedWidth }} />
      </div>
      <span className="kf-meter__nums">
        <strong>{fmtUsd(row.food)}</strong>
        {row.linked > 0 ? (
          <span className="kf-meter__linked-note">{pct(row.linked, row.food)} linked</span>
        ) : null}
      </span>
    </div>
  );
}
