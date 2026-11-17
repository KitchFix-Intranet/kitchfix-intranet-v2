// Empty-state cards for the service calendar. Framed as a note, not
// an apology.

import { CalendarDays } from "lucide-react";

export function NoAccess() {
  return (
    <section className="kf-sc-empty" aria-label="No calendar for you yet">
      <span className="kf-sc-empty__icon"><CalendarDays size={22} strokeWidth={1.5} aria-hidden /></span>
      <div>
        <h3>No calendar for you yet</h3>
        <p>Ask the office if you should have one.</p>
      </div>
    </section>
  );
}

export function NoRosterRow() {
  return (
    <section className="kf-sc-empty" aria-label="We cannot find you on the roster">
      <span className="kf-sc-empty__icon"><CalendarDays size={22} strokeWidth={1.5} aria-hidden /></span>
      <div>
        <h3>We cannot find you on the roster</h3>
        <p>Ask the office to check your record.</p>
      </div>
    </section>
  );
}

export function TwentySeven() {
  return (
    <section className="kf-sc-empty" aria-label="2027 not loaded">
      <span className="kf-sc-empty__icon"><CalendarDays size={22} strokeWidth={1.5} aria-hidden /></span>
      <div>
        <h3>The 2027 calendar is not loaded yet</h3>
        <p>Fiscal 2027 runs Dec 28, 2026 to Dec 26, 2027.</p>
      </div>
    </section>
  );
}
