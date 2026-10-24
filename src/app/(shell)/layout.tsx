import { requireOwnerPage } from "@/lib/gate";
import { Shell } from "@/components/shell/Shell";

export default async function ShellLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { email } = await requireOwnerPage();
  return <Shell email={email}>{children}</Shell>;
}
