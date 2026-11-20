import { StockpotNext } from "@/components/reserved/StockpotNext";
import { requireOwnerPage } from "@/lib/gate";

export default async function Page() {
  await requireOwnerPage();
  return (
    <StockpotNext
      one_line="Every dish, in our words - built on the ingredient layer below."
      arrives="Coming after Ingredients"
    />
  );
}
