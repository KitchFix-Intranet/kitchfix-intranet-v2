import { StockpotNext } from "@/components/reserved/StockpotNext";
import { requireOwnerPage } from "@/lib/gate";

export default async function Page() {
  await requireOwnerPage();
  return (
    <StockpotNext
      one_line="Collections of recipes with sort, allergens, and sign-and-label behavior."
      arrives="Coming after Recipes"
    />
  );
}
