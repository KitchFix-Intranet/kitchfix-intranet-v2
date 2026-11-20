import { redirect } from "next/navigation";
import { requireOwnerPage } from "@/lib/gate";

export default async function Page() {
  await requireOwnerPage();
  redirect("/stockpot/ingredients");
}
