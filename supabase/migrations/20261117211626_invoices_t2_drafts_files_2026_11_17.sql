-- Invoices V2, train 2 - drafts and files (record of what was applied)
-- Applied to the live database on 2026-11-17 by Chat-Claude on Kevin's word
-- ("apply"), as migration 20261117211626_invoices_t2_drafts_files_2026_11_17.
-- CC never runs this file. It is in the repo as the record.
--
-- In plain words: one private file bucket (invoice-files) and two new tables
-- (invoice_drafts, invoice_files). The server can read, add and change rows.
-- It cannot delete. The public and signed-in keys have no access. No table
-- that existed before was changed.
--
-- Checked after applying: both tables exist with 0 rows, the bucket is
-- private with a 50 MB limit, row security is on with no policies, the
-- service role holds INSERT, SELECT and UPDATE only, and invoice_submissions
-- had the same row count before and after.
--
-- To undo (nothing else depends on these):
--   drop table public.invoice_files;
--   drop table public.invoice_drafts;
--   delete from storage.buckets where id = 'invoice-files';  -- only if empty

-- 2a. The bucket. Private. 50 MB a file. PDF and the picture kinds a phone
--     or scanner makes. The app checks the file's real kind again on upload.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'invoice-files',
  'invoice-files',
  false,
  52428800,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
);

-- 2b. Drafts. One row per invoice being typed.
--     Who writes which column (one writer today, the V2 app):
--       the app writes every column. No other system writes this table.
create table public.invoice_drafts (
  id              uuid primary key default gen_random_uuid(),
  -- who started it (a draft belongs to that person) and for which site
  owner_email     text        not null check (owner_email = lower(owner_email)),
  owner_worker_id text,
  account_key     text        not null references public.accounts (team_key),
  -- what the person picked and typed. All optional until they send.
  vendor_id       text        references public.vendors (id),
  type            text        not null default 'invoice'
                  check (type in ('invoice', 'credit')),
  invoice_number  text,
  invoice_date    date,
  total_amount    numeric(12, 2),
  gl_breakdown    jsonb       not null default '[]'::jsonb
                  check (jsonb_typeof(gl_breakdown) = 'array'),
  -- answers to the one-time questions (a copy? this date? invoice or credit?)
  answers         jsonb       not null default '{}'::jsonb
                  check (jsonb_typeof(answers) = 'object'),
  -- desk or phone, for the no-names signal (lane master, section 9)
  screen          text        check (screen in ('desk', 'phone')),
  -- where it stands. 'sent' and submission_id are filled by train 3.
  status          text        not null default 'draft'
                  check (status in ('draft', 'sent', 'discarded')),
  submission_id   uuid        references public.invoice_submissions (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  discarded_at    timestamptz,
  -- a sent draft points at its invoice; an unsent one does not
  constraint invoice_drafts_sent_has_submission
    check ((status = 'sent') = (submission_id is not null))
);

comment on table public.invoice_drafts is
  'Invoices V2: an invoice being typed, not sent yet. Written only by the V2 app (service role). Rows are never deleted; a dropped draft is status = discarded.';

create index invoice_drafts_owner_idx   on public.invoice_drafts (owner_email, status, updated_at desc);
create index invoice_drafts_account_idx on public.invoice_drafts (account_key, status, updated_at desc);

-- 2c. Files. One row per uploaded file. The file itself is in the bucket,
--     kept exactly as uploaded. Rotation is how to show it, not a change to
--     the file.
create table public.invoice_files (
  id            uuid primary key default gen_random_uuid(),
  draft_id      uuid        references public.invoice_drafts (id),
  submission_id uuid        references public.invoice_submissions (id),
  kind          text        not null default 'original'
                check (kind in ('original', 'outbound')),
  storage_path  text        not null unique,
  file_name     text        not null,
  mime_type     text        not null,
  size_bytes    bigint      not null check (size_bytes > 0 and size_bytes <= 52428800),
  -- the file's fingerprint (SHA-256, 64 hex characters): catches the same
  -- file uploaded twice
  sha256        text        not null check (sha256 ~ '^[0-9a-f]{64}$'),
  page_count    integer     check (page_count is null or page_count > 0),
  -- order of this file among the draft's files, and how it is turned on screen
  sort_order    integer     not null default 0 check (sort_order >= 0),
  rotation      integer     not null default 0 check (rotation in (0, 90, 180, 270)),
  uploaded_by   text        not null check (uploaded_by = lower(uploaded_by)),
  created_at    timestamptz not null default now(),
  -- "remove the file" hides it and can be undone; the row stays
  removed_at    timestamptz,
  constraint invoice_files_has_parent
    check (draft_id is not null or submission_id is not null)
);

comment on table public.invoice_files is
  'Invoices V2: one row per uploaded invoice file in the private bucket invoice-files. Written only by the V2 app (service role). Rows are never deleted; a removed file has removed_at set.';

create index invoice_files_draft_idx      on public.invoice_files (draft_id) where removed_at is null;
create index invoice_files_submission_idx on public.invoice_files (submission_id) where submission_id is not null;
create index invoice_files_sha256_idx     on public.invoice_files (sha256);

-- 2d. Lock both tables down, then let only the server in.
--     Row-level security on with no policies means the public and signed-in
--     keys can read nothing. The service role is not bound by it.
alter table public.invoice_drafts enable row level security;
alter table public.invoice_files  enable row level security;

--     Supabase hands every new table to all three keys by default, so
--     take everything away first, then give the server back only what it needs.
revoke all on public.invoice_drafts from anon, authenticated, service_role;
revoke all on public.invoice_files  from anon, authenticated, service_role;

-- No DELETE and no TRUNCATE on purpose: rows are kept.
grant select, insert, update on public.invoice_drafts to service_role;
grant select, insert, update on public.invoice_files  to service_role;
