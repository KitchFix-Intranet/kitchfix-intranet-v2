// Train 5a / D3 call 1: the Review queue tab's top-bar header. Two
// facts: "groups to review" (the number of cards the page draws) and
// "items not matched yet" (food items with no link at all - the
// unlinked count). Both come from the same cached loader the page's
// ReviewQueue component calls, so the header and the page read the
// same number in one request.

import { requireOwnerPage } from "@/lib/gate";
import { fmtCount } from "@/lib/fmt";
import { loadReview } from "@/components/ingredients/ReviewQueue";
import { TopFacts } from "@/components/ingredients/TopFacts";

export const dynamic = "force-dynamic";

export default async function Page() {
  await requireOwnerPage();
  const { totals } = await loadReview();
  return (
    <TopFacts
      facts={[
        {
          value: fmtCount(totals.groups),
          label: totals.groups === 1 ? "group to review" : "groups to review",
        },
        {
          value: fmtCount(totals.unlinked),
          label: "items not matched yet",
        },
      ]}
    />
  );
}
