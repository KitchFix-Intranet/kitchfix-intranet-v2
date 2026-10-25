-- 0003_potrack_vendor_item_dedup_key.sql
-- intake.ts upserts pr_vendor_items on (vendor_id,item_number_norm) for numbered
-- items and (vendor_id,description_key) for numberless ones. Both 0001 indexes are
-- PARTIAL (num_uq WHERE item_number_norm is not null; desc_uq WHERE item_number_norm
-- is null). PostgREST upsert emits ON CONFLICT (cols) with no WHERE, and Postgres
-- cannot use a partial index as the arbiter without a matching predicate ->
-- "there is no unique or exclusion constraint matching the ON CONFLICT specification"
-- (first Run intake, batch 0/577). Fix: one NON-partial unique key covering both
-- cases. 'n:'/'d:' prefixes prevent a number from colliding with a description_key.

alter table pr_vendor_items
  add column if not exists dedup_key text
  generated always as (
    case when item_number_norm is not null then 'n:' || item_number_norm
         else 'd:' || description_key end
  ) stored;

create unique index if not exists pr_vendor_items_dedup_uq
  on pr_vendor_items (vendor_id, dedup_key);

-- The two partial indexes are fully superseded by the line above and can no longer
-- serve as upsert arbiters; drop them so there is one authoritative dedup key.
drop index if exists pr_vendor_items_num_uq;
drop index if exists pr_vendor_items_desc_uq;
