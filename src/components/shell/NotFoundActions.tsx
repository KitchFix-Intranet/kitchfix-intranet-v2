"use client";

// Small client island mounted inside app/not-found.tsx. Renders the Back
// button only when there is a prior entry in the browser history to go
// back to. Sign out posts to the same endpoint the account menu uses.
// Plain tags, no shell classes - the 404 stays unbranded on purpose.

import { useEffect, useState } from "react";

export function NotFoundActions() {
  const [canGoBack, setCanGoBack] = useState(false);
  useEffect(() => {
    setCanGoBack(window.history.length > 1);
  }, []);
  return (
    <p>
      {canGoBack ? (
        <button type="button" onClick={() => window.history.back()}>
          Go back
        </button>
      ) : null}
      <form action="/api/auth/signout" method="post" style={{ display: "inline" }}>
        <button type="submit">Sign out</button>
      </form>
    </p>
  );
}
