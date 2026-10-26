"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Download } from "lucide-react";

// Export the current vendor-items filter set as CSV. Preserves the URL
// search params so the download matches what the user sees.
export function ExportCsvLink() {
  const sp = useSearchParams();
  const qs = new URLSearchParams(sp?.toString() ?? "");
  qs.delete("drawer");
  qs.delete("page");
  const href = `/api/export/vendor-items.csv?${qs.toString()}`;
  return (
    <Link href={href} className="kf-btn kf-btn--line kf-btn--sm">
      <Download size={14} strokeWidth={1.5} />
      <span>Export CSV</span>
    </Link>
  );
}
