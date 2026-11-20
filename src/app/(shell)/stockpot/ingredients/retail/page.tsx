import { IngredientMasters } from "@/components/ingredients/IngredientMasters";
import { requireOwnerPage } from "@/lib/gate";

export const dynamic = "force-dynamic";

// B7 (nee R2): the Retail tab is the Ingredients masters workbench
// with `mode="resale"`. The user-visible word is Retail; the mode
// name mirrors the DB column `pr_ingredients.resale` so the server
// query stays obvious (`.eq("resale", mode === "resale")`). URL
// slug is /retail; mode value is "resale"; column is "resale".
// One workbench, two consumers; no new component tree, no new
// query shape - just a server-side filter on pr_ingredients.resale.
export default async function Page() {
  await requireOwnerPage();
  return <IngredientMasters mode="resale" />;
}
