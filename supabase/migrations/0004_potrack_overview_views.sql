-- 0004_potrack_overview_views.sql
-- The overview aggregated pr_vendor_items in JS from one unpaginated select,
-- capped at 1,000 rows -> tiles showed 630/$389K/291 vs a DB of 8,039/$1.82M/1,575.
-- Aggregate in Postgres instead. security_invoker so service_role's grants apply.

create or replace view pr_v_overview_totals
with (security_invoker = true) as
select
  count(*) filter (where status = 'duplicate')                                                        as twins_count,
  count(*) filter (where pack_state = 'ok')                                                            as packs_clean,
  count(*) filter (where is_food and status in ('active','resale'))                                    as food_items_active,
  count(*) filter (where is_food and status in ('active','resale') and item_number_norm is not null)   as food_items_with_number,
  count(*) filter (where is_food and status in ('active','resale') and item_number_norm is null)       as no_number_items,
  coalesce(sum(usd_12m) filter (where is_food and status in ('active','resale') and item_number_norm is null),0) as no_number_dollars,
  count(*) filter (where is_food and status in ('active','resale') and catch_weight)                   as catch_weight_items,
  count(*) filter (where is_food and status in ('active','resale') and link_status in ('none','proposed')) as food_items_waiting,
  coalesce(sum(usd_12m) filter (where is_food and status in ('active','resale') and link_status in ('none','proposed')),0) as food_items_waiting_usd,
  coalesce(sum(usd_12m) filter (where is_food and status in ('active','resale')),0)                    as food_dollars_total,
  coalesce(sum(usd_12m) filter (where is_food and status in ('active','resale') and link_status = 'confirmed'),0) as food_dollars_linked
from pr_vendor_items;

create or replace view pr_v_overview_by_account
with (security_invoker = true) as
select a.acct as account_key,
  sum(vi.usd_12m / greatest(1, cardinality(vi.accounts)))                                              as food,
  coalesce(sum(vi.usd_12m / greatest(1, cardinality(vi.accounts))) filter (where vi.link_status='confirmed'),0) as linked
from pr_vendor_items vi
cross join lateral unnest(vi.accounts) as a(acct)
where vi.is_food and vi.status in ('active','resale')
group by a.acct;

create or replace view pr_v_overview_by_vendor
with (security_invoker = true) as
select vi.vendor_id, v.name as vendor_name,
  sum(vi.usd_12m)                                                                                      as food,
  coalesce(sum(vi.usd_12m) filter (where vi.link_status='confirmed'),0)                                as linked
from pr_vendor_items vi
join pr_vendors v on v.id = vi.vendor_id
where vi.is_food and vi.status in ('active','resale')
group by vi.vendor_id, v.name;

revoke all on pr_v_overview_totals, pr_v_overview_by_account, pr_v_overview_by_vendor from public;
grant select on pr_v_overview_totals, pr_v_overview_by_account, pr_v_overview_by_vendor to service_role;
