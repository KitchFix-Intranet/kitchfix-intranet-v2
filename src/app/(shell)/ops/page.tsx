import { ReservedDoor } from "@/components/reserved/ReservedDoor";

export default function Page() {
  return (
    <ReservedDoor
      name="Ops Hub"
      one_line="Runs on the current intranet today. Migrates to v2 when the ops data layer is rebuilt."
      reserved_bullets={[
        "Receiving and close checklists.",
        "Site-level day-to-day running state.",
        "The one place a general manager looks each morning.",
      ]}
      plug_in_bullets={[
        "URL stays /ops once this door becomes live.",
        "Reads from the ops schema that is still TBD.",
        "Shell chrome does not change when this flips on.",
      ]}
    />
  );
}
