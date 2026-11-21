import { IngredientMasters } from "@/components/ingredients/IngredientMasters";
import { requireOwnerPage } from "@/lib/gate";

export const dynamic = "force-dynamic";

// T6 ruling 3: ?open=<ingredient id> opens the tab with that
// ingredient selected and scrolled into view. T6 reads only; train 7
// writes the URL and owns the full pattern (F15). An unknown or
// retired id falls through to the default view (no selection). The
// key stays out of loadMasters's cached-loader key so the @topbar
// facts do not depend on it.
export default async function Page({
  searchParams,
}: {
  searchParams?: Promise<{ open?: string | string[] }>;
}) {
  await requireOwnerPage();
  const params = (await searchParams) ?? {};
  const raw = Array.isArray(params.open) ? params.open[0] : params.open;
  const openId = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
  return <IngredientMasters openId={openId} />;
}
