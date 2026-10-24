import { ReservedDoor } from "@/components/reserved/ReservedDoor";

export default function Page() {
  return (
    <ReservedDoor
      name="Recipes"
      one_line="Next up after Ingredients. Builds on the ingredient layer below - every recipe eventually references ingredient uuids, not vendor items."
      reserved_bullets={[
        "A recipe is a named recipe plus a list of ingredient lines.",
        "Each ingredient line carries a quantity, a unit, and a preparation.",
        "Each recipe tracks who wrote it and when it was last verified.",
      ]}
      plug_in_bullets={[
        "URL will be /stockpot/recipes once live.",
        "Reads from pr_recipes + pr_recipe_lines (not yet created).",
        "Depends on step 5 (ingredient naming) and step 6 (prices) landing first.",
      ]}
    />
  );
}
