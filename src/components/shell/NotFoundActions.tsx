"use client";

// Small client island mounted inside app/not-found.tsx. Renders the Back
// button only when there is a prior entry in the browser history to go
// back to. Sign out posts to the same endpoint the account menu uses.
// Plain tags, no shell classes - the 404 stays unbranded on purpose.
//
// The wrapper is a <div>, not a <p>: a <form> is forbidden inside a <p>
// and the browser closes the paragraph early, which trips the server/
// client hydration mismatch in docs/GOTCHAS.md item 14 on the one page
// every locked-out person sees.

import { useEffect, useState } from "react";

export function NotFoundActions() {
  const [canGoBack, setCanGoBack] = useState(false);
  useEffect(() => {
    setCanGoBack(window.history.length > 1);
  }, []);
  return (
    <div>
      {canGoBack ? (
        <button type="button" onClick={() => window.history.back()}>
          Go back
        </button>
      ) : null}
      <form action="/api/auth/signout" method="post" style={{ display: "inline" }}>
        <button type="submit">Sign out</button>
      </form>
    </div>
  );
}
