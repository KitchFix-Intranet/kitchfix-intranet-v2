import { serviceClient } from "@/lib/supabase/service";
import { RunIntakeButton } from "@/components/ingredients/RunIntakeButton";

export default async function Page() {
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
