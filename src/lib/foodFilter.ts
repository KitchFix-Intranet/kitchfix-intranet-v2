// Food filter. Per-line check, first hit wins. Writes land on pr_vendor_items
// (is_food, food_reason) at aggregate time and on pr_price_observations
// (excluded_reason) at observation time.

import { VendorRule } from "./vendors";

export type FoodVerdict = {
  isFood: boolean;
  reason: string;
};

const CHARGE_PATTERNS = [
  /fuel\s*surcharge/i,
  /service\s*charge/i,
  /\bsvcchg\b/i,
  /machine\s*service/i,
  /minimum\s*invoice/i,
  /\bpropane\b/i,
  /delivery\s*fee/i,
  /\bmisc\b/i,
  /\badjmnt\b/i,
  /\bfschg\b/i,
  /\brent\b/i,
];

const NON_FOOD_CATEGORIES = new Set(["supplies", "packaging", "cleaning", "smallwares"]);

export function classifyLine(
  rule: VendorRule,
  category: string | null | undefined,
  description: string
): FoodVerdict {
  if (rule === "never_food") return { isFood: false, reason: "vendor_rule" };
  if (rule === "always_food") return { isFood: true, reason: "vendor_rule" };

  const cat = (category ?? "").toLowerCase();
  if (NON_FOOD_CATEGORIES.has(cat)) return { isFood: false, reason: "category" };

  for (const pat of CHARGE_PATTERNS) {
    if (pat.test(description)) return { isFood: false, reason: "charge" };
  }

  return { isFood: true, reason: "default" };
}
