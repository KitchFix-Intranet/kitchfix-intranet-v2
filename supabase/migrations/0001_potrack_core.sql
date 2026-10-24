-- 0001_potrack_core.sql
-- KitchFix intranet v2 - Stockpot / Ingredients (PotRack) core schema.
--
-- Hard rules this file obeys:
--   1. Every object is prefixed pr_. Nothing in this file writes to or alters a non-pr_ table.
--   2. The whole file is idempotent (create ... if not exists, drop policy ... if exists, etc.)
--      so Kevin can re-run it in Studio without harm.
--   3. RLS is on for every pr_ table. The dark-phase pin is in pr_my_role(): an active row
--      in pr_users keyed to auth.jwt() ->> 'email' is required for any policy to let a user in.
--      The service_role bypasses RLS by default (BYPASSRLS); the intake job relies on that.
--   4. No hard deletes - status columns and merged_into pointers only. This file does not
--      grant DELETE to any application role for ingredient / vendor-item tables.
--
-- Views:
--   pr_v_invoice_lines is a read-only projection of ai_line_items. security_invoker=true
--   so the view honors the caller's permissions on ai_line_items; the intake uses service_role
--   which bypasses RLS, so the view resolves for intake and is inert for everyone else.

begin;

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- A. Helpers
-- ---------------------------------------------------------------------------

create or replace function pr_set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Dark-phase pin + role lookup. SECURITY DEFINER so policy evaluation does not
-- recurse into pr_users' own RLS. search_path is pinned (pg_catalog first) so
-- a malicious schema planted on the session search_path cannot shadow a
-- built-in function or operator used during policy evaluation.
create or replace function pr_my_role() returns text
language sql
security definer
stable
set search_path = pg_catalog, public
as $$
  select role
  from pr_users
  where email = lower(coalesce(auth.jwt() ->> 'email', ''))
    and active = true
  limit 1
$$;

revoke all on function pr_my_role() from public;
grant execute on function pr_my_role() to authenticated;

-- ---------------------------------------------------------------------------
-- B. Tables
-- ---------------------------------------------------------------------------

-- pr_users -------------------------------------------------------------------
create table if not exists pr_users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  name text,
  role text not null check (role in ('curator', 'site', 'viewer')),
  account_key text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists pr_users_email_lc_idx on pr_users (lower(email));

-- pr_vendors -----------------------------------------------------------------
create table if not exists pr_vendors (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  rule text not null default 'mixed' check (rule in ('always_food', 'mixed', 'never_food')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- pr_vendor_aliases ----------------------------------------------------------
create table if not exists pr_vendor_aliases (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references pr_vendors(id) on delete restrict,
  alias_text text not null,
  alias_norm text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists pr_vendor_aliases_vendor_idx on pr_vendor_aliases (vendor_id);

-- pr_ingredients -------------------------------------------------------------
create table if not exists pr_ingredients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  name_norm text not null,
  parent text,
  grade text,
  base_unit text not null check (base_unit in ('lb', 'each', 'gal', 'dozen')),
  status text not null default 'active' check (status in ('active', 'proposed', 'retired', 'merged')),
  merged_into_id uuid references pr_ingredients(id) on delete restrict,
  yield_pct numeric,
  yield_source text,
  fdc_id integer,
  fdc_name text,
  fdc_data_type text,
  fdc_linked_by text,
  fdc_linked_at timestamptz,
  allergens text[] not null default '{}',
  may_contain text[] not null default '{}',
  allergens_reviewed_by text,
  allergens_reviewed_at timestamptz,
  resale boolean not null default false,
  last_verified_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists pr_ingredients_name_norm_live_uq
  on pr_ingredients (name_norm) where status <> 'merged';
create index if not exists pr_ingredients_status_idx on pr_ingredients (status);

-- pr_ingredient_aliases ------------------------------------------------------
create table if not exists pr_ingredient_aliases (
  id uuid primary key default gen_random_uuid(),
  ingredient_id uuid not null references pr_ingredients(id) on delete restrict,
  alias_text text not null,
  alias_norm text not null,
  kind text not null check (kind in ('vendor', 'legacy', 'site', 'rename', 'manual')),
  learned_from_event uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (alias_norm, kind)
);
create index if not exists pr_ingredient_aliases_ingredient_idx on pr_ingredient_aliases (ingredient_id);

-- pr_ingredient_yields -------------------------------------------------------
create table if not exists pr_ingredient_yields (
  id uuid primary key default gen_random_uuid(),
  ingredient_id uuid not null references pr_ingredients(id) on delete restrict,
  preparation text not null,
  yield_pct numeric not null,
  source text,
  set_by text,
  set_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ingredient_id, preparation)
);

-- pr_vendor_items ------------------------------------------------------------
create table if not exists pr_vendor_items (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references pr_vendors(id) on delete restrict,
  item_number text,
  item_number_norm text,
  description_key text not null,
  name text not null,
  status text not null default 'active'
    check (status in ('active', 'archived', 'one_off', 'not_food', 'resale', 'duplicate')),
  duplicate_of_id uuid references pr_vendor_items(id) on delete restrict,
  is_food boolean,
  food_reason text,
  ingredient_id uuid references pr_ingredients(id) on delete restrict,
  link_status text not null default 'none'
    check (link_status in ('none', 'proposed', 'confirmed', 'rejected')),
  link_confidence text,
  link_reason text,
  pack_text text,
  pack_qty numeric,
  pack_size numeric,
  pack_uom text,
  pack_state text not null default 'none' check (pack_state in ('ok', 'check', 'none')),
  pack_note text,
  pack_override jsonb,
  billed_unit text,
  catch_weight boolean not null default false,
  price_estimate jsonb,
  first_seen date,
  last_seen date,
  lines integer not null default 0,
  lines_12m integer not null default 0,
  usd numeric not null default 0,
  usd_12m numeric not null default 0,
  accounts text[] not null default '{}',
  needs_review_lines integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists pr_vendor_items_num_uq
  on pr_vendor_items (vendor_id, item_number_norm) where item_number_norm is not null;
create unique index if not exists pr_vendor_items_desc_uq
  on pr_vendor_items (vendor_id, description_key) where item_number_norm is null;
create index if not exists pr_vendor_items_vendor_idx on pr_vendor_items (vendor_id);
create index if not exists pr_vendor_items_status_idx on pr_vendor_items (status);
create index if not exists pr_vendor_items_link_status_idx on pr_vendor_items (link_status);
create index if not exists pr_vendor_items_ingredient_idx on pr_vendor_items (ingredient_id);

-- pr_vendor_item_aliases -----------------------------------------------------
create table if not exists pr_vendor_item_aliases (
  id uuid primary key default gen_random_uuid(),
  vendor_item_id uuid not null references pr_vendor_items(id) on delete restrict,
  description text not null,
  description_norm text not null,
  count integer not null default 1,
  last_seen date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (vendor_item_id, description_norm)
);
create index if not exists pr_vendor_item_aliases_item_idx on pr_vendor_item_aliases (vendor_item_id);

-- pr_price_observations ------------------------------------------------------
-- No updated_at by design: observations are facts about a single line_id.
create table if not exists pr_price_observations (
  id uuid primary key default gen_random_uuid(),
  vendor_item_id uuid not null references pr_vendor_items(id) on delete restrict,
  line_id uuid not null unique,
  account_key text not null,
  invoice_date date,
  unit_price numeric,
  quantity numeric,
  extended_price numeric,
  billed_unit text,
  pack_text text,
  needs_review boolean not null default false,
  catch_weight boolean not null default false,
  excluded_reason text,
  created_at timestamptz not null default now()
);
create index if not exists pr_price_obs_item_idx on pr_price_observations (vendor_item_id);
create index if not exists pr_price_obs_account_idx on pr_price_observations (account_key);
create index if not exists pr_price_obs_date_idx on pr_price_observations (invoice_date);
create index if not exists pr_price_obs_excluded_idx on pr_price_observations (excluded_reason);

-- pr_events ------------------------------------------------------------------
-- Append-only ledger. No updated_at.
create table if not exists pr_events (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  kind text not null,
  before jsonb,
  after jsonb,
  actor text,
  at timestamptz not null default now(),
  note text
);
create index if not exists pr_events_entity_idx on pr_events (entity_type, entity_id, at desc);
create index if not exists pr_events_at_idx on pr_events (at desc);

-- pr_intake_runs -------------------------------------------------------------
create table if not exists pr_intake_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'ok', 'failed')),
  mode text not null,
  counts jsonb not null default '{}'::jsonb,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists pr_intake_runs_started_idx on pr_intake_runs (started_at desc);

-- pr_coverage_snapshots ------------------------------------------------------
create table if not exists pr_coverage_snapshots (
  id uuid primary key default gen_random_uuid(),
  week_start date not null unique,
  dollars_linked numeric not null default 0,
  dollars_total numeric not null default 0,
  by_account jsonb not null default '{}'::jsonb,
  by_vendor jsonb not null default '{}'::jsonb,
  taken_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- pr_golden_links ------------------------------------------------------------
create table if not exists pr_golden_links (
  id uuid primary key default gen_random_uuid(),
  vendor_item_id uuid not null unique references pr_vendor_items(id) on delete restrict,
  ingredient_id uuid not null references pr_ingredients(id) on delete restrict,
  verified_by text not null,
  verified_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists pr_golden_links_ingredient_idx on pr_golden_links (ingredient_id);

-- ---------------------------------------------------------------------------
-- C. updated_at triggers (idempotent)
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  for t in
    select unnest(array[
      'pr_users',
      'pr_vendors',
      'pr_vendor_aliases',
      'pr_ingredients',
      'pr_ingredient_aliases',
      'pr_ingredient_yields',
      'pr_vendor_items',
      'pr_vendor_item_aliases',
      'pr_intake_runs',
      'pr_coverage_snapshots',
      'pr_golden_links'
    ])
  loop
    execute format('drop trigger if exists %I on %I', t || '_set_updated_at', t);
    execute format(
      'create trigger %I before update on %I for each row execute function pr_set_updated_at()',
      t || '_set_updated_at', t
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- D. View over ai_line_items (read-only projection)
-- ---------------------------------------------------------------------------

create or replace view pr_v_invoice_lines
with (security_invoker = true) as
select
  id,
  account_key,
  vendor_name,
  invoice_uuid,
  invoice_number,
  invoice_date,
  line_num,
  description,
  quantity,
  unit,
  unit_price,
  extended_price,
  category,
  item_number,
  pack_size,
  uom_raw,
  weight_line_value,
  catch_weight_marker,
  needs_review,
  review_reason
from public.ai_line_items;

-- Grants on the view: service_role only. authenticated has no path to
-- ai_line_items through this app, and no reason to query the raw lines
-- directly - everything they need lands in pr_vendor_items /
-- pr_price_observations after intake. Keeping the surface tight.
revoke all on pr_v_invoice_lines from public;
revoke all on pr_v_invoice_lines from authenticated;
grant select on pr_v_invoice_lines to service_role;

-- ---------------------------------------------------------------------------
-- E. RLS: enable on every pr_ table
-- ---------------------------------------------------------------------------

alter table pr_users                 enable row level security;
alter table pr_vendors               enable row level security;
alter table pr_vendor_aliases        enable row level security;
alter table pr_ingredients           enable row level security;
alter table pr_ingredient_aliases    enable row level security;
alter table pr_ingredient_yields     enable row level security;
alter table pr_vendor_items          enable row level security;
alter table pr_vendor_item_aliases   enable row level security;
alter table pr_price_observations    enable row level security;
alter table pr_events                enable row level security;
alter table pr_intake_runs           enable row level security;
alter table pr_coverage_snapshots    enable row level security;
alter table pr_golden_links          enable row level security;

-- ---------------------------------------------------------------------------
-- F. Policies
--
-- Shape:
--   - A single "curator_all" permissive policy per table lets curators read
--     and write everything.
--   - pr_ingredients / pr_ingredient_aliases / pr_ingredient_yields add a
--     "read_role" policy so site and viewer accounts can select those rows.
--   - pr_users carries a self-read policy so a signed-in user can confirm
--     their own row (used by the shell to render the greeting).
--   - anon has no access anywhere. service_role bypasses RLS by default and
--     needs no policy.
--
-- All policies use "drop policy if exists" first so the migration is
-- re-runnable.
-- ---------------------------------------------------------------------------

-- pr_users -------------------------------------------------------------------
drop policy if exists pr_users_curator_all on pr_users;
create policy pr_users_curator_all on pr_users
  for all to authenticated
  using (pr_my_role() = 'curator')
  with check (pr_my_role() = 'curator');

drop policy if exists pr_users_self_read on pr_users;
create policy pr_users_self_read on pr_users
  for select to authenticated
  using (email = lower(coalesce(auth.jwt() ->> 'email', '')));

-- pr_vendors -----------------------------------------------------------------
drop policy if exists pr_vendors_curator_all on pr_vendors;
create policy pr_vendors_curator_all on pr_vendors
  for all to authenticated
  using (pr_my_role() = 'curator')
  with check (pr_my_role() = 'curator');

-- pr_vendor_aliases ----------------------------------------------------------
drop policy if exists pr_vendor_aliases_curator_all on pr_vendor_aliases;
create policy pr_vendor_aliases_curator_all on pr_vendor_aliases
  for all to authenticated
  using (pr_my_role() = 'curator')
  with check (pr_my_role() = 'curator');

-- pr_ingredients -------------------------------------------------------------
drop policy if exists pr_ingredients_curator_all on pr_ingredients;
create policy pr_ingredients_curator_all on pr_ingredients
  for all to authenticated
  using (pr_my_role() = 'curator')
  with check (pr_my_role() = 'curator');

drop policy if exists pr_ingredients_read_role on pr_ingredients;
create policy pr_ingredients_read_role on pr_ingredients
  for select to authenticated
  using (pr_my_role() in ('site', 'viewer'));

-- pr_ingredient_aliases ------------------------------------------------------
drop policy if exists pr_ingredient_aliases_curator_all on pr_ingredient_aliases;
create policy pr_ingredient_aliases_curator_all on pr_ingredient_aliases
  for all to authenticated
  using (pr_my_role() = 'curator')
  with check (pr_my_role() = 'curator');

drop policy if exists pr_ingredient_aliases_read_role on pr_ingredient_aliases;
create policy pr_ingredient_aliases_read_role on pr_ingredient_aliases
  for select to authenticated
  using (pr_my_role() in ('site', 'viewer'));

-- pr_ingredient_yields -------------------------------------------------------
drop policy if exists pr_ingredient_yields_curator_all on pr_ingredient_yields;
create policy pr_ingredient_yields_curator_all on pr_ingredient_yields
  for all to authenticated
  using (pr_my_role() = 'curator')
  with check (pr_my_role() = 'curator');

drop policy if exists pr_ingredient_yields_read_role on pr_ingredient_yields;
create policy pr_ingredient_yields_read_role on pr_ingredient_yields
  for select to authenticated
  using (pr_my_role() in ('site', 'viewer'));

-- pr_vendor_items ------------------------------------------------------------
drop policy if exists pr_vendor_items_curator_all on pr_vendor_items;
create policy pr_vendor_items_curator_all on pr_vendor_items
  for all to authenticated
  using (pr_my_role() = 'curator')
  with check (pr_my_role() = 'curator');

-- pr_vendor_item_aliases -----------------------------------------------------
drop policy if exists pr_vendor_item_aliases_curator_all on pr_vendor_item_aliases;
create policy pr_vendor_item_aliases_curator_all on pr_vendor_item_aliases
  for all to authenticated
  using (pr_my_role() = 'curator')
  with check (pr_my_role() = 'curator');

-- pr_price_observations ------------------------------------------------------
drop policy if exists pr_price_observations_curator_all on pr_price_observations;
create policy pr_price_observations_curator_all on pr_price_observations
  for all to authenticated
  using (pr_my_role() = 'curator')
  with check (pr_my_role() = 'curator');

-- pr_events ------------------------------------------------------------------
-- Append-only in app code; policy still lets curators insert and read.
-- Updates and deletes are not expected but curators retain access so a
-- bad row can be corrected by hand if needed. Site/viewer have no access.
drop policy if exists pr_events_curator_all on pr_events;
create policy pr_events_curator_all on pr_events
  for all to authenticated
  using (pr_my_role() = 'curator')
  with check (pr_my_role() = 'curator');

-- pr_intake_runs -------------------------------------------------------------
drop policy if exists pr_intake_runs_curator_all on pr_intake_runs;
create policy pr_intake_runs_curator_all on pr_intake_runs
  for all to authenticated
  using (pr_my_role() = 'curator')
  with check (pr_my_role() = 'curator');

-- pr_coverage_snapshots ------------------------------------------------------
drop policy if exists pr_coverage_snapshots_curator_all on pr_coverage_snapshots;
create policy pr_coverage_snapshots_curator_all on pr_coverage_snapshots
  for all to authenticated
  using (pr_my_role() = 'curator')
  with check (pr_my_role() = 'curator');

-- pr_golden_links ------------------------------------------------------------
drop policy if exists pr_golden_links_curator_all on pr_golden_links;
create policy pr_golden_links_curator_all on pr_golden_links
  for all to authenticated
  using (pr_my_role() = 'curator')
  with check (pr_my_role() = 'curator');

-- ---------------------------------------------------------------------------
-- G. Grants (defense in depth; RLS still gates row access)
-- ---------------------------------------------------------------------------

-- anon gets nothing on the pr_ tables. authenticated gets select on everything
-- (filtered by RLS), plus write on the tables curators own (also filtered by
-- RLS). The revoke is scoped to the thirteen pr_ tables by name so this
-- migration never touches a non-pr_ object (hard rule #1).
revoke all on
  pr_users,
  pr_vendors,
  pr_vendor_aliases,
  pr_ingredients,
  pr_ingredient_aliases,
  pr_ingredient_yields,
  pr_vendor_items,
  pr_vendor_item_aliases,
  pr_price_observations,
  pr_events,
  pr_intake_runs,
  pr_coverage_snapshots,
  pr_golden_links
from anon;

grant select on
  pr_users,
  pr_vendors,
  pr_vendor_aliases,
  pr_ingredients,
  pr_ingredient_aliases,
  pr_ingredient_yields,
  pr_vendor_items,
  pr_vendor_item_aliases,
  pr_price_observations,
  pr_events,
  pr_intake_runs,
  pr_coverage_snapshots,
  pr_golden_links
to authenticated;

grant insert, update on
  pr_users,
  pr_vendors,
  pr_vendor_aliases,
  pr_ingredients,
  pr_ingredient_aliases,
  pr_ingredient_yields,
  pr_vendor_items,
  pr_vendor_item_aliases,
  pr_price_observations,
  pr_events,
  pr_intake_runs,
  pr_coverage_snapshots,
  pr_golden_links
to authenticated;

commit;

-- ---------------------------------------------------------------------------
-- Seeds for pr_users (curator rows for Kevin and Britt) live in the companion
-- file supabase/seed/0001_users.sql. Kevin fills in the exact names if he
-- wants them to differ from the email local-part, then applies that seed
-- separately in Studio. The migration above seeds nothing.
-- ---------------------------------------------------------------------------
