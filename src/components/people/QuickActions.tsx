// Four quick-action doors on My team. Inert in T2: the routes
// they would lead to do not exist yet. Each carries aria-disabled
// and the same short line "Coming with its own build step".
// No navigation, no href to v1 (per prompt section 3).

import { Inbox, UserPlus, ClipboardList, TriangleAlert } from "lucide-react";

type Door = {
  key: string;
  label: string;
  one_line: string;
  Icon: typeof Inbox;
};

const DOORS: Door[] = [
  { key: "inbox",     label: "Inbox",    one_line: "What's waiting on you.",           Icon: Inbox },
  { key: "new-hire",  label: "New Hire", one_line: "Start someone who is not in the system.", Icon: UserPlus },
  { key: "paf",       label: "PAF",      one_line: "Change pay, title, hours, home.",  Icon: ClipboardList },
  { key: "incident",  label: "Incident", one_line: "Report something that happened.",  Icon: TriangleAlert },
];

export function QuickActions() {
  return (
    <div className="kf-pe-doors" aria-label="Quick actions">
      {DOORS.map((d) => (
        <article
          key={d.key}
          className="kf-pe-door"
          aria-disabled="true"
          aria-label={`${d.label} - coming with its own build step`}
        >
          <span className="kf-pe-door__icon" aria-hidden>
            <d.Icon size={20} strokeWidth={1.5} />
          </span>
          <div className="kf-pe-door__body">
            <h3>{d.label}</h3>
            <p>{d.one_line}</p>
          </div>
          <div className="kf-pe-door__facts">
            <span className="kf-pe-muted">Coming with its own build step</span>
          </div>
        </article>
      ))}
    </div>
  );
}
