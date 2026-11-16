-- Service Calendar: let the week's record remember its push to QuickBooks.
-- Written by Chat-Claude, Nov 16, 2026. APPLIED to the live database on Nov 16, 2026 on Kevin's say-so,
-- as migration sc_week_finalize_push_retry_2026_11_16 (version 20261116193640). This file is the record.
-- Do not run it again. Repo copy: supabase/migrations/20261116193640_sc_week_finalize_push_retry_2026_11_16.sql
--
-- What it does, in plain words: adds six columns to sc_week_finalize. Nothing existing changes.
--   submitted_via      who made the row: 'v2' for a submit made in V2, empty for every row v1 made
--   push_attempts      how many times V2 has tried to send the invoice (0 to start)
--   push_next_try_at   when V2's job should try next (empty when there is nothing to try)
--   push_done_at       when the push finished, or was found not to be needed
--   push_gave_up_at    when V2 stopped retrying and told Kevin and Sebastian
--   push_last_error    the last failure, in words (up to 500 characters)
--
-- Why 'submitted_via' matters: V2's retry job only ever picks up rows marked 'v2'.
-- The 47 rows v1 has made (38 submitted, 9 reverted) stay empty and can never be picked up.
--
-- Who else reads this table (checked Nov 16): v1's calendar route, v1's reminder job and v1's
-- engine. Each names the columns it reads or inserts; none is affected by extra columns.
-- No view and no database function reads the table. Its one trigger only stamps changed_at.

-- 1. LOOK FIRST. Before the change this read: 10 columns, 47 rows (38 finalized, 9 reverted), none of the six new names.
select (select count(*) from information_schema.columns where table_schema='public' and table_name='sc_week_finalize') as columns_now,
       (select count(*) from public.sc_week_finalize) as rows_now,
       (select count(*) from public.sc_week_finalize where status='finalized') as finalized,
       (select count(*) from public.sc_week_finalize where status='reverted') as reverted,
       (select count(*) from information_schema.columns where table_schema='public' and table_name='sc_week_finalize'
          and column_name in ('submitted_via','push_attempts','push_next_try_at','push_done_at','push_gave_up_at','push_last_error')) as new_columns_already_there;

-- 2. THE CHANGE.
alter table public.sc_week_finalize
  add column if not exists submitted_via    text,
  add column if not exists push_attempts    integer not null default 0,
  add column if not exists push_next_try_at timestamptz,
  add column if not exists push_done_at     timestamptz,
  add column if not exists push_gave_up_at  timestamptz,
  add column if not exists push_last_error  text;

alter table public.sc_week_finalize
  add constraint sc_week_finalize_submitted_via_check check (submitted_via is null or submitted_via = 'v2'),
  add constraint sc_week_finalize_push_attempts_check check (push_attempts >= 0),
  add constraint sc_week_finalize_push_last_error_check check (push_last_error is null or length(push_last_error) <= 500);

create index if not exists idx_sc_week_finalize_push_due
  on public.sc_week_finalize (push_next_try_at)
  where submitted_via = 'v2' and push_done_at is null and push_gave_up_at is null and status <> 'reverted';

-- 3. CHECK. Expect: 16 columns, the same 47 rows, 0 rows marked v2, 0 with attempts above 0, 0 due.
select (select count(*) from information_schema.columns where table_schema='public' and table_name='sc_week_finalize') as columns_now,
       (select count(*) from public.sc_week_finalize) as rows_now,
       (select count(*) from public.sc_week_finalize where submitted_via is not null) as marked_v2,
       (select count(*) from public.sc_week_finalize where push_attempts <> 0) as with_attempts,
       (select count(*) from public.sc_week_finalize where push_next_try_at is not null) as due;

-- UNDO (only if needed; safe while no row is marked v2).
-- drop index if exists public.idx_sc_week_finalize_push_due;
-- alter table public.sc_week_finalize
--   drop constraint if exists sc_week_finalize_submitted_via_check,
--   drop constraint if exists sc_week_finalize_push_attempts_check,
--   drop constraint if exists sc_week_finalize_push_last_error_check,
--   drop column if exists submitted_via, drop column if exists push_attempts, drop column if exists push_next_try_at,
--   drop column if exists push_done_at, drop column if exists push_gave_up_at, drop column if exists push_last_error;
