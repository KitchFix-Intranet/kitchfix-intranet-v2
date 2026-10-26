// /academy/read/[requirementId] topbar slot. Train B ships a stub reader
// page; "Save and exit" sends the user back to the To do list. Train C
// replaces this with a real save-and-exit that posts progress first.
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export default function Page() {
  return (
    <Link href="/academy" className="kf-btn kf-btn--line">
      <ArrowLeft size={16} strokeWidth={1.5} />
      <span>Save and exit</span>
    </Link>
  );
}
