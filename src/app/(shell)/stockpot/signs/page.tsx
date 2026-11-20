import { StockpotNext } from "@/components/reserved/StockpotNext";
import { requireOwnerPage } from "@/lib/gate";

export default async function Page() {
  await requireOwnerPage();
  return (
    <StockpotNext
      one_line="Every tabletop sign and every dish label, from the same canonical recipe."
      arrives="Coming after Menus"
    />
  );
}
