import { Overview } from "@/components/ingredients/Overview";
import { requireOwnerPage } from "@/lib/gate";

export const dynamic = "force-dynamic";

export default async function Page() {
  await requireOwnerPage();
  return <Overview />;
}
