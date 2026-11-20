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
// T6 ruling 3: ?open=<ingredient id> reads the same query key as
// the Ingredients tab (the two tabs share one workbench). Read-only
// in this train; train 7 writes.
export default async function Page({
  searchParams,
}: {
  searchParams?: Promise<{ open?: string | string[] }>;
}) {
  await requireOwnerPage();
  const params = (await searchParams) ?? {};
  const raw = Array.isArray(params.open) ? params.open[0] : params.open;
  const openId = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
  return <IngredientMasters mode="resale" openId={openId} />;
}
