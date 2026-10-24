import { VendorItemsPage } from "@/components/ingredients/VendorItemsPage";

export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function Page({ searchParams }: Props) {
  const sp = await searchParams;
  return <VendorItemsPage searchParams={sp} />;
}
