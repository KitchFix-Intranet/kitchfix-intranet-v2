import { IngredientMasters } from "@/components/ingredients/IngredientMasters";

export const dynamic = "force-dynamic";

// R2: the Resale tab is the Ingredients masters workbench with
// `mode="resale"`. One workbench, two consumers; no new component
// tree, no new query shape - just a server-side filter on
// pr_ingredients.resale. The resale cascade and the resale toggle
// in the editor already exist; this page is a reader.
export default async function Page() {
  return <IngredientMasters mode="resale" />;
}
