import { ReservedDoor } from "@/components/reserved/ReservedDoor";

export default function Page() {
  return (
    <ReservedDoor
      name="Menus"
      one_line="Later. A menu is a collection of recipes with sort, allergen, and sign-and-label behavior attached."
      reserved_bullets={[
        "Period menus, event menus, and the live service menu.",
        "Sort, categorize, and label each dish with inherited allergens.",
        "The source material for signs, labels, and chef prep sheets.",
      ]}
      plug_in_bullets={[
        "URL will be /stockpot/menus once live.",
        "Depends on Recipes landing first.",
        "No schema yet.",
      ]}
    />
  );
}
