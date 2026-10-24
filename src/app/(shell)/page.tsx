import { requireOwnerPage } from "@/lib/gate";
import { Home } from "@/components/home/Home";

export default async function Page() {
  const { email } = await requireOwnerPage();
  return <Home email={email} />;
}
