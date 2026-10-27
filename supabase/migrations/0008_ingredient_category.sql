-- 0008_ingredient_category.sql  (FIXED: qualify pr_vendor_items columns in pr_v_overview_totals)
-- The join to pr_ingredients made unqualified `status` ambiguous (both tables have it).
-- Fix: vi.-qualify every pr_vendor_items column in the totals view. Other two views were already qualified.
-- Idempotent end to end; safe to re-run after the failed attempt.

alter table pr_ingredients
  add column if not exists category text;

update pr_ingredients set category = case parent
  when 'Beef'                    then 'Proteins'
  when 'Chicken'                 then 'Proteins'
  when 'Pork'                    then 'Proteins'
  when 'Lamb and game'           then 'Proteins'
  when 'Seafood'                 then 'Proteins'
  when 'Eggs'                    then 'Proteins'
  when 'Vegetables and herbs'    then 'Produce'
  when 'Fruit'                   then 'Produce'
  when 'Dairy'                   then 'Dairy'
  when 'Sauces and bases'        then 'Pantry / Dry goods'
  when 'Oils and vinegars'       then 'Pantry / Dry goods'
  when 'Rice and grains'         then 'Pantry / Dry goods'
  when 'Sweeteners'              then 'Pantry / Dry goods'
  when 'Nuts and snacks'         then 'Pantry / Dry goods'
  when 'Frozen and prepared'     then 'Prepared & frozen'
  when 'Bakery'                  then 'Bakery'
  when 'Beverages'               then 'Beverages'
  else null
end
where category is null;

create index if not exists pr_ingredients_category_idx
  on pr_ingredients (category)
  where status <> 'merged';

create or replace view pr_v_overview_totals
with (security_invoker = true) as
select
  count(*) filter (where vi.status = 'duplicate')                                                             as twins_count,
  count(*) filter (where vi.pack_state = 'ok')                                                                as packs_clean,
  count(*) filter (where vi.is_food and vi.status in ('active','resale'))                                     as food_items_active,
  count(*) filter (where vi.is_food and vi.status in ('active','resale') and vi.item_number_norm is not null) as food_items_with_number,
  count(*) filter (where vi.is_food and vi.status in ('active','resale') and vi.item_number_norm is null)     as no_number_items,
  coalesce(sum(vi.usd_12m) filter (where vi.is_food and vi.status in ('active','resale') and vi.item_number_norm is null),0) as no_number_dollars,
  count(*) filter (where vi.is_food and vi.status in ('active','resale') and vi.catch_weight)                 as catch_weight_items,
  count(*) filter (where vi.is_food and vi.status in ('active','resale') and vi.link_status in ('none','proposed')) as food_items_waiting,
  coalesce(sum(vi.usd_12m) filter (where vi.is_food and vi.status in ('active','resale') and vi.link_status in ('none','proposed')),0) as food_items_waiting_usd,
  coalesce(sum(vi.usd_12m) filter (where vi.is_food and vi.status in ('active','resale')),0)                  as food_dollars_total,
  coalesce(sum(vi.usd_12m) filter (where vi.is_food and vi.status in ('active','resale') and vi.link_status = 'confirmed' and i.resale is false),0) as food_dollars_linked,
  coalesce(sum(vi.usd_12m) filter (where vi.is_food and vi.status in ('active','resale') and vi.link_status = 'confirmed' and i.resale is true),0)  as resale_dollars_linked
from pr_vendor_items vi
left join pr_ingredients i on i.id = vi.ingredient_id;

create or replace view pr_v_overview_by_account
with (security_invoker = true) as
select a.acct as account_key,
  sum(vi.usd_12m / greatest(1, cardinality(vi.accounts)))                                                    as food,
  coalesce(sum(vi.usd_12m / greatest(1, cardinality(vi.accounts))) filter (where vi.link_status='confirmed' and i.resale is false),0) as linked,
  coalesce(sum(vi.usd_12m / greatest(1, cardinality(vi.accounts))) filter (where vi.link_status='confirmed' and i.resale is true),0)  as resale_linked
from pr_vendor_items vi
cross join lateral unnest(vi.accounts) as a(acct)
left join pr_ingredients i on i.id = vi.ingredient_id
where vi.is_food and vi.status in ('active','resale')
group by a.acct;

create or replace view pr_v_overview_by_vendor
with (security_invoker = true) as
select vi.vendor_id, v.name as vendor_name,
  sum(vi.usd_12m)                                                                                            as food,
  coalesce(sum(vi.usd_12m) filter (where vi.link_status='confirmed' and i.resale is false),0)                as linked,
  coalesce(sum(vi.usd_12m) filter (where vi.link_status='confirmed' and i.resale is true),0)                 as resale_linked
from pr_vendor_items vi
join pr_vendors v on v.id = vi.vendor_id
left join pr_ingredients i on i.id = vi.ingredient_id
where vi.is_food and vi.status in ('active','resale')
group by vi.vendor_id, v.name;

revoke all on pr_v_overview_totals, pr_v_overview_by_account, pr_v_overview_by_vendor from public;
grant select on pr_v_overview_totals, pr_v_overview_by_account, pr_v_overview_by_vendor to service_role;
