// /library/suggestions - owner-only. Three lists on one page:
// Open (the default), Accepted - not changed yet, Closed. Each
// shows its count. A note moves between lists via the action
// route; nothing ever just disappears.
//
// The three lists are server-rendered. The `?list=` query param
// decides which one is visible; empty = Open.

import { requireOwnerPage } from "@/lib/gate";
import {
  listOpenSuggestions,
  listAcceptedSuggestions,
  listClosedSuggestions,
} from "@/lib/academy/suggestions";
import { SuggestionsBoard } from "@/components/library/SuggestionsBoard";
import "@/components/library/library.css";

type Props = {
  searchParams: Promise<{ list?: string }>;
};

export default async function Page({ searchParams }: Props) {
  await requireOwnerPage();
  const sp = await searchParams;
  const which = sp?.list === "accepted" || sp?.list === "closed" ? sp.list : "open";

  // Pull every list so the counts are honest regardless of which
  // list is on screen. Three queries, all small.
  const [openL, acceptedL, closedL] = await Promise.all([
    listOpenSuggestions(),
    listAcceptedSuggestions(),
    listClosedSuggestions(),
  ]);
  return (
    <SuggestionsBoard
      openList={openL}
      acceptedList={acceptedL}
      closedList={closedL}
      initial={which as "open" | "accepted" | "closed"}
    />
  );
}
