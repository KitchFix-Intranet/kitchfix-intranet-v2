// /library/shelves - retired in L2. The Library is one page now
// (the bookcase at /library). A 308 permanent redirect so bookmarks,
// the shell menu and the browser's Back do the right thing.
//
// The shell's menu still links here today; that menu belongs to the
// shared-foundation lane and is not edited in this train. The
// redirect ensures the click still lands on the right page.

import { permanentRedirect } from "next/navigation";

export default function Page() {
  permanentRedirect("/library");
}
