// /academy/done topbar slot. Carries the "Download" action for the whole
// record. In train B this is a plain anchor to a route that does not exist
// yet - train E ships the full-record download. For now, point at the
// current-signed-in-user's /api/academy/records JSON as the honest
// placeholder so the button has a real target (owner-gated, JSON of what
// Done is already showing).
import { Download } from "lucide-react";

export default function Page() {
  return (
    <a href="/api/academy/records" className="kf-btn kf-btn--line" download>
      <Download size={16} strokeWidth={1.5} />
      <span>Download</span>
    </a>
  );
}
