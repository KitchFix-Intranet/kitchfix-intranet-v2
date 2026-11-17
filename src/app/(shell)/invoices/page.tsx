// /invoices - the lane's entry address. Train 1 keeps this as a
// redirect to the list, preserving ?as. Capture (train 2) takes
// this address; this redirect is the only thing that moves.

import { redirect } from "next/navigation";
import { requireOwnerPage } from "@/lib/gate";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ as?: string | string[] }>;
}) {
  await requireOwnerPage();
  const sp = await searchParams;
  const as = pickOne(sp.as);
  const qs = as ? `?as=${encodeURIComponent(as)}` : "";
  redirect(`/invoices/list${qs}`);
}

function pickOne(v: string | string[] | undefined): string | null {
  if (!v) return null;
  if (Array.isArray(v)) return v[0] ?? null;
  return v;
}
