// Train 5 fix 5 (2026-11-20): one pure helper for the "open again"
// sentence. The component in `src/components/service/CalendarPage.tsx`
// re-exports this and wraps it in the <p role="status">. The helper
// is here (not next to the component) so the test can import it
// without crossing into a .tsx file.

import { fmtDate } from "@/lib/fmt";

export function buildReopenedNoticeLine(input: {
  startIso: string;
  endIso: string;
  isPair: boolean;
}): string {
  const dates = `${fmtDate(input.startIso, "short")} - ${fmtDate(input.endIso, "short")}`;
  return input.isPair
    ? `The two weeks of ${dates} are open again.`
    : `Week of ${dates} is open again.`;
}
