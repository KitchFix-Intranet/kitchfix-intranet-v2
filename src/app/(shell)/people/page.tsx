import { ReservedDoor } from "@/components/reserved/ReservedDoor";

export default function Page() {
  return (
    <ReservedDoor
      name="People Portal"
      one_line="Runs on the current intranet today. Migrates to v2 when the people data layer is rebuilt."
      reserved_bullets={[
        "Teams, roles, and manager chains.",
        "Onboarding steps and sign-off state.",
        "The directory and its filter / search surface.",
      ]}
      plug_in_bullets={[
        "URL stays /people once this door becomes live.",
        "Reads from pr_users plus a people-dedicated schema that is still TBD.",
        "Shell chrome (rail, topbar, phone tab bar) does not change when this flips on.",
      ]}
    />
  );
}
