// Train 5a / D3 call 1: the Vendor items tab's top-bar header. Two
// facts for the whole catalog (not the user's chip or vendor filter)
// plus the Export CSV action. The facts come from the tiny shared
// loader `loadVendorItemsHeader`, cached per request; the action is
// a static client-rendered link.

import { requireOwnerPage } from "@/lib/gate";
import { fmtCount } from "@/lib/fmt";
import { ExportCsvLink } from "@/components/shell/ExportCsvLink";
import { TopFacts } from "@/components/ingredients/TopFacts";
import { loadVendorItemsHeader } from "@/lib/ingredients/loaders/vendorItemsHeader";

export const dynamic = "force-dynamic";

export default async function Page() {
  await requireOwnerPage();
  const { all, unlinked } = await loadVendorItemsHeader();
  return (
    <>
      <TopFacts
        facts={[
          { value: fmtCount(all), label: "items" },
          { value: fmtCount(unlinked), label: "not matched yet" },
        ]}
      />
      <ExportCsvLink />
    </>
  );
}
