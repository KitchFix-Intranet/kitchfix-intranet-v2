// Train 5a / D3 call 1: the Ingredients tab's top-bar header. Three
// facts: "ingredients", "linked items" and "need attention" (only
// when above zero). Every number comes from `loadMasters("recipe")`,
// the same cached loader IngredientMasters renders the page body
// from - so the header and the page body cannot disagree.

import { requireOwnerPage } from "@/lib/gate";
import { fmtCount } from "@/lib/fmt";
import { loadMasters } from "@/components/ingredients/IngredientMasters";
import { TopFacts, type TopFact } from "@/components/ingredients/TopFacts";

export const dynamic = "force-dynamic";

export default async function Page() {
  await requireOwnerPage();
  const { totals } = await loadMasters("recipe");
  const facts: TopFact[] = [
    { value: fmtCount(totals.masters), label: "ingredients" },
    { value: fmtCount(totals.linked), label: "linked items" },
  ];
  if (totals.needsAttention > 0) {
    facts.push({
      value: fmtCount(totals.needsAttention),
      label: "need attention",
      tone: "warn",
    });
  }
  return <TopFacts facts={facts} />;
}
