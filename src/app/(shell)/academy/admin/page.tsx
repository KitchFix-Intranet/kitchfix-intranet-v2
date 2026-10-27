// /academy/admin - Cycles. Owner-only (requireOwnerPage 404s non-
// owners before anything renders). Server component: gates, loads
// the cycles catalog + obligations picker, hands data to the client
// island. No handlers / hooks cross the RSC boundary; every write
// is behind an API route that re-applies the owner gate.

import { requireOwnerPage } from "@/lib/gate";
import { loadCycles, loadObligationsCatalog } from "@/lib/academy/cycles";
import { CyclesAdmin } from "@/components/academy/admin/CyclesAdmin";
import "@/components/academy/admin/admin.css";

export default async function Page() {
  // The owner gate is enforced here (and inside every admin API
  // route). The shell layout already runs requireOwnerPage() too;
  // this is belt + suspenders so a direct deep link into
  // /academy/admin still 404s a non-owner.
  await requireOwnerPage();

  const [cycles, obligations] = await Promise.all([
    loadCycles(),
    loadObligationsCatalog(),
  ]);

  return <CyclesAdmin cycles={cycles} obligations={obligations} />;
}
