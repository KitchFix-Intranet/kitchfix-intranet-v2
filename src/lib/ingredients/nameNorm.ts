// N10 §2b: one shared normaliser for ingredient names.
//
// Mirrors reviewWrites.ts's long-standing inline rule exactly:
//   trim + lowercase + collapse runs of whitespace to a single space.
//
// Called from:
//   - reviewWrites.ts createIngredient (was inline at ~746)
//   - reviewWrites.ts normName (was inline at ~925; deleted)
//   - src/components/ingredients/ReviewActions.tsx (new) - client-side
//     name-match detection so the panel reads the same answer the
//     server's name_norm lookup gives.
//
// Chat-Claude verified 2026-11-12 on production: 515 active
// ingredients, 0 duplicate name_norm, 0 rows where stored name_norm
// differs from this rule, 0 null category, 0 null parent. So the
// client match is exact.

export function canonicalIngredientName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}
