// Overview slot. Train 3 / GOTCHA 22: a slot page that reads data must
// call the owner gate itself, because the shared layout's
// `requireAppAccess` only runs on full loads. Train 5a leaves Overview's
// IdentBand in place; this slot carries the Run intake action only.

import { requireOwnerPage } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { RunIntakeButton } from "@/components/ingredients/RunIntakeButton";

export const dynamic = "force-dynamic";

export default async function Page() {
  await requireOwnerPage();
  const client = serviceClient();
  const { data } = await client
    .from("pr_intake_runs")
    .select("status")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const running = (data as { status?: string } | null)?.status === "running";
  return <RunIntakeButton disabled={running} />;
}
