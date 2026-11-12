// Four quick actions on My team. Inert in T2.2: the routes they
// would lead to do not exist yet. Each carries aria-disabled and
// the render's one-line sub per action. No navigation, no href to
// v1.
//
// T2.2 (2026-11-12). Render uses .kf-pe-qa row shape (not full-
// height door cards). Icon left, text middle, chevron right.

import { Inbox, UserPlus, ClipboardList, TriangleAlert, ChevronRight } from "lucide-react";

type Action = {
  key: string;
  label: string;
  one_line: string;
  Icon: typeof Inbox;
};

const ACTIONS: Action[] = [
  { key: "inbox",    label: "Inbox",    one_line: "What you sent",            Icon: Inbox },
  { key: "newhire",  label: "New Hire", one_line: "Bring someone on",         Icon: UserPlus },
  { key: "paf",      label: "PAF",      one_line: "For someone on your team", Icon: ClipboardList },
  { key: "incident", label: "Incident", one_line: "Report what happened",     Icon: TriangleAlert },
];

export function QuickActions() {
  return (
    <div className="kf-pe-qas" aria-label="Quick actions">
      {ACTIONS.map((a) => (
        <span
          key={a.key}
          className="kf-pe-qa kf-pe-disabled"
          aria-disabled="true"
          aria-label={`${a.label} - coming with its own build step`}
        >
          <span className="kf-pe-qa__icon" aria-hidden>
            <a.Icon size={22} strokeWidth={1.5} />
          </span>
          <span className="kf-pe-qa__text">
            <b>{a.label}</b>
            <small>{a.one_line}</small>
          </span>
          <ChevronRight size={18} strokeWidth={1.5} aria-hidden className="kf-pe-qa__chev" />
        </span>
      ))}
    </div>
  );
}
