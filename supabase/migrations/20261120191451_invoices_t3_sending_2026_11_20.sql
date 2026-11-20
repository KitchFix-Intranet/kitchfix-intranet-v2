-- Invoices V2, train 3: sending. Two new tables and one function.
-- Applied to the live database on 2026-11-20 by Chat-Claude, on Kevin's
-- word for this file, as migration 20261120191451_invoices_t3_sending_2026_11_20.
-- This file is the record. Statements are exactly what was applied.
--
-- Checked after applying: both tables empty, row security on, no policies;
-- service_role holds INSERT, SELECT, UPDATE on invoice_sends and INSERT,
-- SELECT on invoice_send_attempts; only service_role may run the function;
-- invoice_submissions, invoice_drafts and invoice_files row counts unchanged.
-- No existing table, column, index or constraint was changed.

-- ---------------------------------------------------------------------
-- Step 1. invoice_sends: one row per invoice V2 has sent.
-- ---------------------------------------------------------------------
create table public.invoice_sends (
  id                    uuid primary key default gen_random_uuid(),
  submission_id         uuid not null unique references public.invoice_submissions(id),
  draft_id              uuid not null unique references public.invoice_drafts(id),
  mode                  text not null check (mode in ('test', 'live')),
  outbound_file_id      uuid references public.invoice_files(id),
  email_status          text not null default 'held'
                          check (email_status in ('held', 'sent', 'gave_up')),
  email_attempts        integer not null default 0 check (email_attempts >= 0),
  email_last_error      text check (email_last_error is null or length(email_last_error) <= 200),
  email_next_attempt_at timestamptz default now(),
  email_sent_at         timestamptz,
  email_message_id      text,
  claimed_until         timestamptz,
  slack_status          text not null default 'pending'
                          check (slack_status in ('pending', 'sent', 'failed', 'skipped')),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check ((email_status = 'sent') = (email_sent_at is not null))
);

comment on table public.invoice_sends is
  'Invoices V2: one row per invoice sent from V2. mode says test or live. email_status: held (not delivered yet, will retry), sent, gave_up.';

create index invoice_sends_held_idx
  on public.invoice_sends (email_next_attempt_at)
  where email_status = 'held';

alter table public.invoice_sends enable row level security;
revoke all on public.invoice_sends from anon, authenticated, service_role;
grant select, insert, update on public.invoice_sends to service_role;

-- ---------------------------------------------------------------------
-- Step 2. invoice_send_attempts: the log. Append-only: no update, no delete.
-- error_code is a short code, never an address, a name or an amount.
-- ---------------------------------------------------------------------
create table public.invoice_send_attempts (
  id           uuid primary key default gen_random_uuid(),
  send_id      uuid not null references public.invoice_sends(id),
  channel      text not null check (channel in ('email', 'slack')),
  result       text not null check (result in ('sent', 'failed', 'skipped')),
  error_code   text check (error_code is null or length(error_code) <= 200),
  attempted_at timestamptz not null default now()
);

comment on table public.invoice_send_attempts is
  'Invoices V2: one row per try at sending. Append-only.';

create index invoice_send_attempts_send_idx on public.invoice_send_attempts (send_id, attempted_at);

alter table public.invoice_send_attempts enable row level security;
revoke all on public.invoice_send_attempts from anon, authenticated, service_role;
grant select, insert on public.invoice_send_attempts to service_role;

-- ---------------------------------------------------------------------
-- Step 3. The function. One call turns a ready draft into an invoice:
--   - locks the draft so two calls cannot both run;
--   - a draft already sent returns its invoice (a double send makes one);
--   - writes the invoice row (credit total stored negative, as v1 does);
--   - marks the draft sent, ties its files to the invoice, opens the send row;
--   - if the database's own no-copies rule refuses the row, returns 'copy'
--     and changes nothing.
-- All of it or none of it.
-- The app runs every Ready check first. The function re-checks only the
-- fields the invoice row cannot do without.
-- ---------------------------------------------------------------------
create function public.invoices_v2_commit_send(
  p_draft_id    uuid,
  p_owner_email text,
  p_mode        text
)
returns table (result text, invoice_id uuid)
language plpgsql
security invoker
set search_path = public
as $$
declare
  d            public.invoice_drafts%rowtype;
  v_id         uuid;
  v_vendor     text;
  v_pages      integer;
  v_total      numeric;
  v_override   boolean;
begin
  if p_mode is null or p_mode not in ('test', 'live') then
    raise exception 'invoices_v2_commit_send: mode must be test or live';
  end if;

  select * into d
    from public.invoice_drafts
   where id = p_draft_id and owner_email = lower(p_owner_email)
     for update;

  if not found then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;

  if d.status = 'sent' then
    return query select 'already_sent'::text, d.submission_id;
    return;
  end if;

  if d.status <> 'draft' then
    return query select 'not_a_draft'::text, null::uuid;
    return;
  end if;

  select v.name into v_vendor
    from public.vendors v
   where v.id = d.vendor_id and v.deleted_at is null;

  select coalesce(sum(coalesce(f.page_count, 1)), 0)::integer into v_pages
    from public.invoice_files f
   where f.draft_id = d.id and f.removed_at is null and f.kind = 'original';

  if v_vendor is null
     or d.invoice_number is null or btrim(d.invoice_number) = ''
     or d.invoice_date is null
     or d.total_amount is null or d.total_amount <= 0
     or jsonb_typeof(d.gl_breakdown) <> 'array' or jsonb_array_length(d.gl_breakdown) = 0
     or v_pages = 0 then
    return query select 'not_ready'::text, null::uuid;
    return;
  end if;

  v_total    := case when d.type = 'credit' then -abs(d.total_amount) else d.total_amount end;
  v_override := coalesce((d.answers -> 'is_different_invoice') = 'true'::jsonb, false);

  begin
    insert into public.invoice_submissions (
      client_uuid, submitter_email, account_key, vendor_name, vendor_id,
      invoice_number, invoice_date, total_amount, gl_breakdown,
      page_count, type, status, email_sent, dupe_override, data_provenance
    ) values (
      d.id, d.owner_email, d.account_key, v_vendor, d.vendor_id,
      btrim(d.invoice_number), d.invoice_date, v_total, d.gl_breakdown,
      v_pages, d.type, 'sent', false, v_override, 'app_scan'
    )
    returning id into v_id;
  exception when unique_violation then
    -- The draft is locked and was not sent, so this is the no-copies rule:
    -- the same vendor, number, date and total is already on file.
    return query select 'copy'::text, null::uuid;
    return;
  end;

  update public.invoice_drafts
     set status = 'sent', submission_id = v_id, updated_at = now()
   where id = d.id;

  update public.invoice_files
     set submission_id = v_id
   where draft_id = d.id and removed_at is null;

  insert into public.invoice_sends (submission_id, draft_id, mode)
  values (v_id, d.id, p_mode);

  return query select 'sent'::text, v_id;
end;
$$;

comment on function public.invoices_v2_commit_send(uuid, text, text) is
  'Invoices V2: turn a ready draft into an invoice, all or nothing. Returns (result, invoice_id); result is sent, already_sent, copy, not_ready, not_a_draft or not_found.';

revoke all on function public.invoices_v2_commit_send(uuid, text, text) from public, anon, authenticated;
grant execute on function public.invoices_v2_commit_send(uuid, text, text) to service_role;
