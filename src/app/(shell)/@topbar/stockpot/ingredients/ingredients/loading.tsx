// Train 5a R2 / ruling 3: Suspense fallback for the Ingredients
// slot. Empty while `loadMasters("recipe")` resolves (the blend
// pipeline takes a couple of seconds on a cold load); the rail,
// the top bar's title + crumb, and the Ingredients page's own
// skeleton paint at once.
export default function Loading() {
  return null;
}
