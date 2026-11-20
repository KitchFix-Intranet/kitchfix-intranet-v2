import { ReservedDoor } from "@/components/reserved/ReservedDoor";
import { requireOwnerPage } from "@/lib/gate";

export default async function Page() {
  await requireOwnerPage();
  return (
    <ReservedDoor
      slug="kpi"
      one_line="The numbers that run the business, period over period."
    />
  );
}
