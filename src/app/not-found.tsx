// The plain Next.js 404. Rendered when:
//   - a signed-in non-owner hits any protected route (via notFound() in the
//     shared gate helper), or
//   - any legitimate 404 happens.
//
// No styling. No KitchFix tokens. No favicon. The dark-phase page must not
// hint at the app's existence or match any branded chrome. This is the
// carve-out from the "no raw hex outside tokens.css" rule because it is
// intentionally not a KitchFix surface.

export const metadata = {
  title: "404 Not Found",
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <main>
      <h1>404</h1>
      <p>This page could not be found.</p>
    </main>
  );
}
