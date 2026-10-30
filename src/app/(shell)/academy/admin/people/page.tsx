// /academy/admin/people - People (roster + compliance + region
// leads). Owner-only (requireOwnerPage 404s non-owners before
// anything renders). Server component: gates, loads the roster via
// loadAdminPeople, hands data to the client island. No handlers /
// hooks cross the RSC boundary; the one write (assign/unassign a
// region lead) is behind an owner-gated API route.

import { requireOwnerPage } from "@/lib/gate";
import { loadAdminPeople } from "@/lib/academy/admin/people";
import { PeopleAdmin } from "@/components/academy/admin/PeopleAdmin";
import "@/components/academy/admin/admin.css";

export default async function Page() {
  // Belt + suspenders: the (shell) layout already runs
  // requireOwnerPage(), but a direct deep link into this path still
  // 404s a non-owner because requireOwnerPage calls notFound().
  await requireOwnerPage();

  const view = await loadAdminPeople();

  return <PeopleAdmin view={view} />;
}
