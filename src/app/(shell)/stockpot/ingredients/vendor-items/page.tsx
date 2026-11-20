import { VendorItemsPage } from "@/components/ingredients/VendorItemsPage";
import { requireOwnerPage } from "@/lib/gate";

export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function Page({ searchParams }: Props) {
  await requireOwnerPage();
  const sp = await searchParams;
  return <VendorItemsPage searchParams={sp} />;
}
