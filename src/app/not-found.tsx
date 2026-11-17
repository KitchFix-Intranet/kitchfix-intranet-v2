// Plain Next.js 404. Rendered when:
//   - a signed-in non-owner hits any protected route (via notFound() in
//     the shared gate helper), or
//   - any legitimate 404 happens.
//
// No logo, no tool names, no link into any tool, no class from
// components.css. The gate answers "not found" to anyone outside the
// owner list on purpose, so they learn nothing about the tools. Do not
// style this with KitchFix tokens. The "Go back" island is a tiny
// client component; the page itself is a server component.

import { NotFoundActions } from "@/components/shell/NotFoundActions";

export const metadata = {
  title: "Page not available",
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <main>
      <h1>This page is not available</h1>
      <p>It may not exist, or your account may not have access to it.</p>
      <NotFoundActions />
    </main>
  );
}
