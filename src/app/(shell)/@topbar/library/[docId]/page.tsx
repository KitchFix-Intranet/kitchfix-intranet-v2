// /library/[docId] topbar slot. Print + PDF actions for the open
// document. Print is a plain window.print() client island; PDF is
// deferred (printing to PDF is already a browser capability, and a
// dedicated server-side renderer for Library documents is a later
// train).
import { PrintDocButton } from "@/components/library/PrintDocButton";

export default function Page() {
  return <PrintDocButton />;
}
