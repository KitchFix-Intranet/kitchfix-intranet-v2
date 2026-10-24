import { ReservedDoor } from "@/components/reserved/ReservedDoor";

export default function Page() {
  return (
    <ReservedDoor
      name="KPI Dashboard"
      one_line="Runs on the current intranet today. Migrates to v2 when the KPI data layer is rebuilt."
      reserved_bullets={[
        "The numbers that run the business, period over period.",
        "Labor, revenue, purchasing, and the drill paths beneath them.",
        "The boards that an owner opens most mornings.",
      ]}
      plug_in_bullets={[
        "URL stays /kpi once this door becomes live.",
        "Reads from the finance / KPI schema that is still TBD.",
        "Shell chrome does not change when this flips on.",
      ]}
    />
  );
}
