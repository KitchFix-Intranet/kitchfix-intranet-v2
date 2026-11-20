import { ReservedDoor } from "@/components/reserved/ReservedDoor";
import { requireOwnerPage } from "@/lib/gate";

export default async function Page() {
  await requireOwnerPage();
  return (
    <ReservedDoor
      slug="ops"
      one_line="Receiving, closes, and the day-to-day running of a site."
    />
  );
}
