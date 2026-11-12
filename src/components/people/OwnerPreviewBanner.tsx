// Owner-preview ribbon. Renders only when the viewer has been
// overridden via ?as=<worker_id> and the signed-in viewer is an
// owner (both gates are upstream; this component only displays).

import Link from "next/link";

export function OwnerPreviewBanner({ name }: { name: string }) {
  return (
    <div className="kf-pe-preview" role="status" aria-live="polite">
      <span>Viewing as {name}. Owner preview.</span>
      <Link href="/people" className="kf-pe-preview__exit">
        Exit preview
      </Link>
    </div>
  );
}
