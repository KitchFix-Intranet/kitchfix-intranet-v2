// Root match for the @topbar parallel slot. The sibling [...catchAll] page
// cannot match "/" because a catch-all requires at least one segment; without
// this file, a soft nav back to Home from a route whose slot carries an
// action (Stockpot Overview, Academy Done, ...) would leave that action
// behind in the top bar. Returns null for the same reason default.tsx does.
export default function Page() {
  return null;
}
