"use client";

// First-visit welcome card. Shown on the To do page when
// RoomBody.viewer.record.firstRun is true. Dismissed by "Got it" or by
// the first signature. Dismissal persists in localStorage (non-fatal if
// storage throws - private-mode browsers do not crash the app).

import { useEffect, useState } from "react";

const KEY = "kf.academy.firstvisit.dismissed";

type Props = {
  displayName?: string | null;
};

export function FirstVisitCard({ displayName }: Props) {
  const [dismissed, setDismissed] = useState<boolean | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(KEY);
      setDismissed(raw === "1");
    } catch {
      setDismissed(false);
    }
  }, []);

  if (dismissed) return null;
  // While we're reading storage, hide the card to avoid a flash. The
  // server renders it; the client hides immediately on mount if the user
  // already dismissed it.
  if (dismissed === null) return null;

  const name = (displayName ?? "").trim().split(/\s+/)[0] || null;
  const greeting = name ? `Welcome, ${name}.` : "Welcome.";

  return (
    <section className="kf-firstvisit" aria-label="Welcome">
      <h2 className="kf-firstvisit__title">{greeting}</h2>
      <p className="kf-firstvisit__body">
        Everything on your list waits here until you read it and sign.
        Your place is saved. Nothing is recorded until you sign.
      </p>
      <div className="kf-firstvisit__row">
        <button
          type="button"
          className="kf-btn kf-btn--soft"
          onClick={() => {
            try {
              window.localStorage.setItem(KEY, "1");
            } catch {
              // non-fatal
            }
            setDismissed(true);
          }}
        >
          Got it
        </button>
      </div>
    </section>
  );
}
