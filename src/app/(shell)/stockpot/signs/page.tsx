import { ReservedDoor } from "@/components/reserved/ReservedDoor";

export default function Page() {
  return (
    <ReservedDoor
      name="Signs & labels"
      one_line="Later. The print surface - every tabletop sign and every dish label traces to the same canonical recipe."
      reserved_bullets={[
        "Serve-day signs with allergen rows derived from the recipe.",
        "Dish labels that batch to the same source of truth.",
        "The one place the print carve-out from the no-hex rule applies.",
      ]}
      plug_in_bullets={[
        "URL will be /stockpot/signs once live.",
        "Depends on Menus landing first.",
        "No schema yet.",
      ]}
    />
  );
}
