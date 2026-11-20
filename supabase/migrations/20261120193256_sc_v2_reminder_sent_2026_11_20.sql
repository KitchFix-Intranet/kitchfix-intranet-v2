-- Service Calendar V2 - a record of which reminder went to which site for which week.
-- RECORD OF A CHANGE ALREADY APPLIED. Do not run it again by hand.
-- Applied 2026-11-20 by Chat-Claude on Kevin's instruction, as migration
-- sc_v2_reminder_sent_2026_11_20, version 20261120193256.
-- Before: no such table. After: 0 rows, 9 columns, row level security on,
-- service_role can select, insert and update. v1's sc_week_chase_sent untouched.

create table if not exists public.sc_v2_reminder_sent (
  id             uuid primary key default gen_random_uuid(),
  account_key    text not null
                 check (account_key ~ '^[A-Z]{3}( - [A-Z]{2,})?( - [HV])?$'),
  -- The Monday the week's submit record carries. For the two-week account this is the
  -- closing week's Monday, the same key sc_week_finalize uses.
  week_start     date not null check (extract(isodow from week_start) = 1),
  stage          text not null check (stage in ('v2.friday', 'v2.monday')),
  recipients_to  text[] not null default '{}',
  recipients_cc  text[] not null default '{}',
  email_result   text check (email_result is null
                             or email_result in ('sent', 'failed', 'skipped_no_recipients')),
  is_test        boolean not null,
  sent_at        timestamptz not null default now(),
  -- One reminder per site, week and stage. A test-mode reminder does not use up the real one.
  unique (account_key, week_start, stage, is_test)
);

comment on table public.sc_v2_reminder_sent is
  'Service Calendar V2: one row per reminder sent (Friday or Monday) per site and week. V2 only; v1 uses sc_week_chase_sent.';

-- Server only. No browser role can read or write it.
alter table public.sc_v2_reminder_sent enable row level security;
revoke all on public.sc_v2_reminder_sent from anon, authenticated;
grant select, insert, update on public.sc_v2_reminder_sent to service_role;
