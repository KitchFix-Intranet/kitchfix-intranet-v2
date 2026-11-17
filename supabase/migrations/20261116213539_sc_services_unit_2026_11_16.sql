-- Service Calendar: say what each service is counted in.
-- Written by Chat-Claude, Nov 16, 2026. APPLIED to the live database on Nov 16, 2026 on Kevin's "yes run it",
-- as migration sc_services_unit_2026_11_16 (version 20261116213539). This file is the record. Do not run it again.
-- Repo copy: supabase/migrations/20261116213539_sc_services_unit_2026_11_16.sql
--
-- Why: rule 19 says "Meals counts meals". A weekly charge, a pan or a day rate is a line on the day,
-- not a meal. Today nothing in the database says which is which. The approved preview guessed from the
-- service's name. This writes the answer down, once, so the calendar reads it instead of guessing.
--
-- What it does, in plain words:
--   1. Adds one column to sc_services: unit. Every service starts as 'meals'.
--   2. Marks 16 named services as not meals (the list is in step 2, by account, group and name).
--      Kevin, Nov 16: coffee and fountain are billed once a week (each); the extra protein pans, the extra
--      MTO sizes and extended day labor are add-ons a client can ask and pay for (pans, each, days); the two
--      fun money lines are not a service at all: a dollar amount the team spends on the client, a cost to
--      KitchFix, never billed (dollars).
--   Nothing else changes. No price, no count, no projection, no invoice rule.
--
-- Who else reads sc_services (checked Nov 16):
--   Database: one view, sc_daily_revenue (names its columns; unaffected). No function. No trigger on the table.
--   v1 code:  the calendar route and its two screens, the calendar data store, the year export, the Boys and
--             Girls Club report, two KPI overview loaders, two Sous AI tools, and seed and audit scripts.
--             Each names the columns it reads or inserts. A new column with a default does not touch any of them.
--   V2 code:  nothing reads the table directly yet.

-- 1. LOOK FIRST. Before the change this read: 105 services, no unit column, 16 matches, 0 duplicate names inside a group.
with wanted(account_key, group_name, service_name, unit) as (values
  ('CIN - AZ','Minor League','Coffee Service','each'),
  ('CIN - AZ','Minor League','Fountain Bev','each'),
  ('STL - FL','Fun Money','Fun Money allocation','dollars'),
  ('TBJ - FL','Other','Fun $$$$ Allocated','dollars'),
  ('TBR - FL','Major League','Extra Protein - Beef/Seafood','pans'),
  ('TBR - FL','Major League','Extra Protein - Chicken/Pork','pans'),
  ('TBR - FL','Major League','MLB - Extra MTO - Lrg','each'),
  ('TBR - FL','Major League','MLB - Extra MTO - Med','each'),
  ('TBR - FL','Major League','MLB - Extra MTO - Sm','each'),
  ('TBR - FL','Minor League','Extended Day Labor','days'),
  ('TBR - FL','Minor League','Extra Protein - Beef/Seafood','pans'),
  ('TBR - FL','Minor League','Extra Protein - Chicken/Pork','pans'),
  ('TXR - AZ','Major League','Extra Protein - Beef/Seafood','pans'),
  ('TXR - AZ','Major League','Extra Protein - Chicken/Pork','pans'),
  ('TXR - AZ','Minor League','Extra Protein - Beef/Seafood','pans'),
  ('TXR - AZ','Minor League','Extra Protein - Chicken/Pork','pans'))
select (select count(*) from public.sc_services) as services_now,
       (select count(*) from information_schema.columns where table_schema='public' and table_name='sc_services' and column_name='unit') as unit_column_already_there,
       (select count(*) from wanted w join public.sc_service_groups g on g.account_key=w.account_key and g.group_name=w.group_name
          join public.sc_services s on s.group_id=g.id and s.account_key=w.account_key and s.service_name=w.service_name) as matches,
       (select count(*) from (select s.account_key, s.group_id, s.service_name from public.sc_services s group by 1,2,3 having count(*)>1) d) as duplicate_names;

-- 2. THE CHANGE. Runs as one piece: if the count is not exactly 16, nothing is kept.
begin;

alter table public.sc_services
  add column if not exists unit text not null default 'meals';

alter table public.sc_services
  add constraint sc_services_unit_check check (unit in ('meals','each','pans','days','dollars'));

do $unit$
declare n integer;
begin
  with wanted(account_key, group_name, service_name, unit) as (values
    ('CIN - AZ','Minor League','Coffee Service','each'),
    ('CIN - AZ','Minor League','Fountain Bev','each'),
    ('STL - FL','Fun Money','Fun Money allocation','dollars'),
    ('TBJ - FL','Other','Fun $$$$ Allocated','dollars'),
    ('TBR - FL','Major League','Extra Protein - Beef/Seafood','pans'),
    ('TBR - FL','Major League','Extra Protein - Chicken/Pork','pans'),
    ('TBR - FL','Major League','MLB - Extra MTO - Lrg','each'),
    ('TBR - FL','Major League','MLB - Extra MTO - Med','each'),
    ('TBR - FL','Major League','MLB - Extra MTO - Sm','each'),
    ('TBR - FL','Minor League','Extended Day Labor','days'),
    ('TBR - FL','Minor League','Extra Protein - Beef/Seafood','pans'),
    ('TBR - FL','Minor League','Extra Protein - Chicken/Pork','pans'),
    ('TXR - AZ','Major League','Extra Protein - Beef/Seafood','pans'),
    ('TXR - AZ','Major League','Extra Protein - Chicken/Pork','pans'),
    ('TXR - AZ','Minor League','Extra Protein - Beef/Seafood','pans'),
    ('TXR - AZ','Minor League','Extra Protein - Chicken/Pork','pans'))
  update public.sc_services s
     set unit = w.unit
    from wanted w
    join public.sc_service_groups g on g.account_key = w.account_key and g.group_name = w.group_name
   where s.group_id = g.id and s.account_key = w.account_key and s.service_name = w.service_name;
  get diagnostics n = row_count;
  if n <> 16 then
    raise exception 'expected to mark 16 services, marked %; nothing was changed', n;
  end if;
end $unit$;

commit;

-- 3. CHECK. Expect: 105 services; meals 89, pans 8, each 5, dollars 2, days 1.
select unit, count(*) from public.sc_services group by unit order by count(*) desc;

-- UNDO (only if needed).
-- alter table public.sc_services drop constraint if exists sc_services_unit_check, drop column if exists unit;
