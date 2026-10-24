import { ReservedDoor } from "@/components/reserved/ReservedDoor";

export default function Page() {
  return (
    <ReservedDoor
      name="Academy"
      one_line="Runs on the current intranet today. Migrates to v2 when the academy content system is rebuilt."
      reserved_bullets={[
        "What every role is expected to know.",
        "How to learn it - lesson sequence and sign-off.",
        "The library of OPD documents behind each lesson.",
      ]}
      plug_in_bullets={[
        "URL stays /academy once this door becomes live.",
        "Reads from the OPD / academy schema that is still TBD.",
        "Shell chrome does not change when this flips on.",
      ]}
    />
  );
}
