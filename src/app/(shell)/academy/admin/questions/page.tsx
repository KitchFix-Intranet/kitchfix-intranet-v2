// /academy/admin/questions - Questions, the Academy content tool.
// Owner-or-author-grant (requireQuestionsAuthor 404s everyone else
// before anything renders). Server component: gates, loads the
// coverage view + the per-module question lists through the authoring
// loader, hands data to the client island. No handlers / hooks cross
// the RSC boundary; every write is behind an API route that re-applies
// the author gate.
//
// Note on the nav / crumb: the sidebar rail entry for "Questions" and
// the shell layout's title+crumb mapping are intentionally NOT in this
// PR - Shell.tsx + (shell)/layout.tsx are shared-foundation files
// (docs/OWNERSHIP.md) and the People Portal lane is editing them this
// week. Kevin applies the nav patch separately. The page ships at a
// real URL with no rail entry pointing at it yet; that is expected.

import { requireQuestionsAuthor } from "@/lib/gate";
import { loadAdminQuestions } from "@/lib/academy/admin/questions";
import { QuestionsAdmin } from "@/components/academy/admin/QuestionsAdmin";
import "@/components/academy/academy.css";
import "@/components/academy/admin/admin.css";

export default async function Page() {
  // Belt + suspenders: the shell layout gates /academy/admin as owner-
  // only too. We re-apply the author-gate here so a direct deep link
  // into /academy/admin/questions still 404s anyone who is not an
  // owner or a questions-author.
  await requireQuestionsAuthor();

  const data = await loadAdminQuestions();
  return <QuestionsAdmin data={data} />;
}
