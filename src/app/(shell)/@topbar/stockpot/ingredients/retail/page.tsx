// Train 5a / D3 call 1: the Retail tab's top-bar header. Two facts:
// "retail ingredients" and "linked items". Resale lives outside the
// recipe-coverage attention math, so the Needs-attention fact never
// shows here (same rule the retired IdentBand had). Both numbers
// come from `loadMasters("resale")`, shared with the page body.

import { requireOwnerPage } from "@/lib/gate";
import { fmtCount } from "@/lib/fmt";
import { loadMasters } from "@/components/ingredients/IngredientMasters";
import { TopFacts } from "@/components/ingredients/TopFacts";

export const dynamic = "force-dynamic";

export default async function Page() {
  await requireOwnerPage();
  const { totals } = await loadMasters("resale");
  return (
    <TopFacts
      facts={[
        { value: fmtCount(totals.masters), label: "retail ingredients" },
        { value: fmtCount(totals.linked), label: "linked items" },
      ]}
    />
  );
}
