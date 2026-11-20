import { IngredientMasters } from "@/components/ingredients/IngredientMasters";
import { requireOwnerPage } from "@/lib/gate";

export const dynamic = "force-dynamic";

export default async function Page() {
  await requireOwnerPage();
  return <IngredientMasters />;
}
