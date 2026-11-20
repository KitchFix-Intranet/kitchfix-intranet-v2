import { ReviewQueue } from "@/components/ingredients/ReviewQueue";
import { requireOwnerPage } from "@/lib/gate";

export const dynamic = "force-dynamic";

export default async function Page() {
  await requireOwnerPage();
  return <ReviewQueue />;
}
