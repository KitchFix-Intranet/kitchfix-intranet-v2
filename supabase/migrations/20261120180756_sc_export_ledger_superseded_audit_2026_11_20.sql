-- Service Calendar: say who marked an invoice as replaced, and when.
--
-- ALREADY APPLIED to the database on 2026-11-20 (migration version
-- 20261120180756). This file is the repo's record of it. Do not run it again;
-- it is safe if someone does (every statement is "if not exists" or a comment).
--
-- Adds three nullable columns to the invoice ledger. Additive only: no
-- existing row or column changed. There is no check constraint, because the
-- one row marked superseded by hand before this date has no such record.
--
-- Before: 16 columns, 1 row superseded. After: 19 columns, the same rows,
-- the same 1 superseded, no row with a new column filled.

alter table public.sc_export_ledger
  add column if not exists superseded_by             text,
  add column if not exists superseded_at             timestamptz,
  add column if not exists superseded_by_finalize_id uuid;

comment on column public.sc_export_ledger.superseded_by is
  'Work email of the person whose reopen marked this row superseded. Empty for rows superseded by hand before 2026-11-20.';
comment on column public.sc_export_ledger.superseded_at is
  'When this row was marked superseded by a reopen. Empty for rows superseded by hand before 2026-11-20.';
comment on column public.sc_export_ledger.superseded_by_finalize_id is
  'The sc_week_finalize row (the submit record) whose reopen superseded this invoice. A soft link, no foreign key.';
