// Train 5a R2 / ruling 3: the slot never holds the page back. A
// `loading.tsx` beside the slot's `page.tsx` wraps it in a React
// Suspense boundary (per Next's loading.md: "In the same folder,
// `loading.js` will be nested inside `layout.js`. It will
// automatically wrap the `page.js` file and any children below in
// a `<Suspense>` boundary"); the slot renders empty while its
// loader resolves, and the rail, the top bar's title + crumb, and
// the page body's own skeleton all paint without waiting.
//
// Return null: the slot's facts are empty while the loader waits;
// no spinner, no stand-in (ruling 3).
export default function Loading() {
  return null;
}
