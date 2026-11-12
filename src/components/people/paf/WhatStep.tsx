"use client";

// What step. 12 actions in four groups. Three selectable in T4a:
//   One-time bonus    (add_bonus)
//   One-time deduction (add_deduction)
//   Gratuity          (add_gratuity)
// The other nine render in their groups, disabled, with one line
// per group saying the rest arrive in the next release. No dead
// links.
//
// A row is a button, not a radio - we use .is-selected on the row
// and an accessible kf-pe-radio dot per the render.

export type PafAction =
  | "add_bonus"
  | "add_deduction"
  | "add_gratuity"
  | "other_reimbursement"
  | "travel_reimbursement"
  | "title_change"
  | "status_change"
  | "rate_change"
  | "pay_increase"
  | "add_cell_phone"
  | "separation";

type Group = {
  heading: string;       // "Money moves" etc.
  route: string;         // "finance" | "HR"
  rows: Array<{ id: PafAction; label: string; sub: string; enabled: boolean }>;
  note?: string;
};

// The twelve actions, grouped per the render. One-time bonus /
// deduction / gratuity are enabled; everyone else is deferred to
// T4b. "Separation" is HR; the four pay-structure actions are
// finance; the three one-time money actions are finance; the two
// comms (cell phone, other reimbursement) are finance.
const GROUPS: Group[] = [
  {
    heading: "Money, one time",
    route: "finance",
    rows: [
      { id: "add_bonus",     label: "One-time bonus",     sub: "Something extra this week",          enabled: true  },
      { id: "add_deduction", label: "One-time deduction", sub: "Pay back a mistake or an advance",   enabled: true  },
      { id: "add_gratuity",  label: "Gratuity",           sub: "Tips distributed",                   enabled: true  },
    ],
  },
  {
    heading: "Pay",
    route: "finance",
    rows: [
      { id: "rate_change",   label: "Rate change",         sub: "A new hourly rate",                 enabled: false },
      { id: "pay_increase",  label: "Pay increase",        sub: "Merit, market, promotion, equity",  enabled: false },
    ],
    note: "Pay changes arrive in the next release.",
  },
  {
    heading: "Status and title",
    route: "HR",
    rows: [
      { id: "title_change",  label: "Title change",        sub: "A new title, same person",          enabled: false },
      { id: "status_change", label: "Part-time / full-time", sub: "Move between hourly and salaried", enabled: false },
      { id: "separation",    label: "Separation",          sub: "They are leaving",                  enabled: false },
    ],
    note: "Status, title and separation arrive in the next release.",
  },
  {
    heading: "Spending and travel",
    route: "finance",
    rows: [
      { id: "travel_reimbursement", label: "Travel reimbursement", sub: "Per diem and travel days",       enabled: false },
      { id: "other_reimbursement",  label: "Other reimbursement",  sub: "Something paid out of pocket",   enabled: false },
      { id: "add_cell_phone",       label: "Cell phone",           sub: "Add or change the stipend",      enabled: false },
    ],
    note: "Reimbursements and cell phone arrive in the next release.",
  },
];

export function WhatStep({
  person, chosen, onChoose, onChange,
}: {
  person: { worker_id: string; display_name: string } | null;
  chosen: PafAction | null;
  onChoose: (a: PafAction) => void;
  onChange: () => void;
}) {
  return (
    <>
      {/* About row with Change back to Who. */}
      {person ? (
        <div className="kf-pe-about">
          <span className="kf-pe-ava" aria-hidden>{(person.display_name || "?").split(/\s+/).map((s) => s[0]).join("").slice(0, 2).toUpperCase()}</span>
          <span className="kf-pe-about__who">
            <b data-about="name">{person.display_name}</b>
          </span>
          <button type="button" className="kf-btn kf-btn--ghost" onClick={onChange}>Change</button>
        </div>
      ) : null}

      {GROUPS.map((g) => (
        <section key={g.heading} className="kf-pe-group-section">
          <div className="kf-pe-group">
            <span>{g.heading}</span>
            <span className="kf-pe-group__route"> · {g.route}</span>
          </div>
          <ul className="kf-pe-picklist" role="radiogroup" aria-label={g.heading}>
            {g.rows.map((row) => {
              const isChosen = chosen === row.id;
              const cls = [
                "kf-pe-typerow",
                isChosen ? "is-selected" : "",
                row.enabled ? "" : "is-off",
              ].filter(Boolean).join(" ");
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    className={cls}
                    role="radio"
                    aria-checked={isChosen ? "true" : "false"}
                    aria-disabled={row.enabled ? undefined : "true"}
                    disabled={!row.enabled}
                    onClick={() => { if (row.enabled) onChoose(row.id); }}
                  >
                    <span className="kf-pe-radio" aria-hidden />
                    <span className="kf-pe-typerow__text">
                      <b>{row.label}</b>
                      <small>{row.sub}</small>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {g.note && g.rows.every((r) => !r.enabled) ? (
            <p className="kf-pe-muted kf-pe-small kf-pe-group-note">{g.note}</p>
          ) : null}
        </section>
      ))}
    </>
  );
}
