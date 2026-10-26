// R-AC17 receipt. Title-first (title before "signed <date>"), white with
// an angled sky-tint stripe. Three sizes: full (Done), row (All set),
// compact (future). Pure props, no data access. Reusable across
// trains B, C, and E.

import Link from "next/link";
import { Download } from "lucide-react";
import { fmtDate } from "@/lib/fmt";

export type ReceiptSize = "full" | "row" | "compact";

export type ReceiptProps = {
  size?: ReceiptSize;
  // What was signed
  docTitle: string;
  moduleLabel?: string | null;
  // The receipt
  signedAt?: string | null;
  certificateSerial?: string | null;
  docVersion?: string | number | null;
  // Where to grab the PDF
  certificateHref?: string | null;
};

function moduleLine(moduleLabel: string | null | undefined, signedAt: string | null | undefined): string {
  const parts: string[] = [];
  if (moduleLabel) parts.push(moduleLabel);
  if (signedAt) parts.push(`signed ${fmtDate(signedAt, "time")}`);
  return parts.join(" - ");
}

function refLine(
  certificateSerial: string | null | undefined,
  docVersion: string | number | null | undefined
): string {
  const parts: string[] = [];
  if (certificateSerial) parts.push(`Certificate ${certificateSerial}`);
  if (docVersion != null) parts.push(`document version ${docVersion}`);
  return parts.join(" - ");
}

export function Receipt({
  size = "full",
  docTitle,
  moduleLabel,
  signedAt,
  certificateSerial,
  docVersion,
  certificateHref,
}: ReceiptProps) {
  const sizeClass = size === "row" ? " kf-receipt--row" : "";
  return (
    <article className={`kf-receipt${sizeClass}`}>
      <h3 className="kf-receipt__title">{docTitle}</h3>
      {size !== "compact" ? (
        <p className="kf-receipt__module">{moduleLine(moduleLabel, signedAt)}</p>
      ) : null}
      {size === "full" ? (
        <p className="kf-receipt__ref">{refLine(certificateSerial, docVersion)}</p>
      ) : null}
      {size === "full" && certificateHref ? (
        <Link
          href={certificateHref}
          className="kf-btn kf-btn--line kf-receipt__cta"
          prefetch={false}
        >
          <Download size={16} strokeWidth={1.5} />
          <span>PDF</span>
        </Link>
      ) : null}
    </article>
  );
}
