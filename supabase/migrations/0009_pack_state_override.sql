-- 0009_pack_state_override.sql
--
-- Extends the pr_vendor_items.pack_state CHECK to include 'override'.
--
-- Phase 1.8 of step 5 introduces the structured pack-override editor,
-- which writes pack_state='override' (plus pack_override jsonb with
-- qty/size/uom/catch_weight) to lock a row's pack as human-attested.
-- The existing backfill guard `.is("pack_override", null)` already
-- provides permanence; the 'override' state value is the matching
-- semantic marker so a reader can filter by state without checking
-- the jsonb payload.
--
-- Idempotent: the DO block drops any current pack_state check by name
-- (constraint names on inline checks are implementation-defined) and
-- then re-adds the extended check. Safe to re-run.
--
-- Applied by Kevin in Supabase Studio before promoting the Phase 1.8
-- code. CC does not apply this migration.

do $$
declare
  cname text;
begin
  select conname
    into cname
    from pg_constraint
    where conrelid = 'pr_vendor_items'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%pack_state%';
  if cname is not null then
    execute format('alter table pr_vendor_items drop constraint %I', cname);
  end if;
end$$;

alter table pr_vendor_items
  add constraint pr_vendor_items_pack_state_check
  check (pack_state in ('ok', 'check', 'none', 'override'));

-- Post-apply verification (run manually):
--   select pack_state, count(*) from pr_vendor_items
--   group by pack_state order by count(*) desc;
-- Expected: existing distribution unchanged; 'override' only appears
-- after the Phase 1.8 UI + migration run.
