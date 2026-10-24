import { ReservedDoor } from "@/components/reserved/ReservedDoor";

export default function Page() {
  return (
    <ReservedDoor
      name="Service Calendar"
      one_line="Runs on the current intranet today. Migrates to v2 when the service calendar is rebuilt."
      reserved_bullets={[
        "What is booked and who is leading each service.",
        "What still needs confirming or chasing.",
        "The ledger of per-service decisions and notes.",
      ]}
      plug_in_bullets={[
        "URL stays /service once this door becomes live.",
        "Reads from the service schema that is still TBD.",
        "Shell chrome does not change when this flips on.",
      ]}
    />
  );
}
