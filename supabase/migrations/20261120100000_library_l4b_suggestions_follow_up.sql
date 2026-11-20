-- 20261120100000_library_l4b_suggestions_follow_up.sql
--
-- Record-only for Library L4b. Applied by Chat-Claude on Kevin's
-- instruction on 2026-11-20 under the migration name
-- `library_l4b_suggestions_follow_up` (not Studio). This file
-- carries the applied SQL word for word so the next clean apply
-- replays what prod already has.
--
-- A) Adds `handled_note` text (nullable) on `public.document_issues`.
-- B) Re-opens the June notes that L3+L4 closed on 2026-11-20 - rolls
--    status back to 'open' and clears handled_by / handled_at /
--    handled_outcome for every row that was CREATED before
--    2026-07-01 AND that was CLOSED on 2026-11-20. Scoped tight
--    so no later note is touched.
--
-- Both statements use idempotent guards (ADD COLUMN IF NOT EXISTS
-- on A, a date-window WHERE on B); a replay on top of today's DB
-- is a no-op.

alter table public.document_issues add column if not exists handled_note text;

update public.document_issues
   set status = 'open', handled_by = null, handled_at = null, handled_outcome = null
 where created_at < '2026-07-01'
   and status = 'closed'
   and handled_at >= '2026-11-20' and handled_at < '2026-11-21';
