-- 0008_ingredient_category.sql
--
-- Two-level categories. `parent` is the sub-category (e.g. "Beef"); this
-- migration adds `category` as the super-category above it ("Proteins").
-- Nullable by design: null = "Needs category" and surfaces in the queue
-- so Kevin can resolve it, instead of guessing wrong.
--
-- Also splits the Overview recipe-coverage number: items whose linked
-- ingredient has `resale = true` (bottled water, etc.) are real purchases
-- to track but not recipe ingredients, so they come out of the headline
-- `food_dollars_linked` figure and move to a new `resale_dollars_linked`
-- column. Same split applied to the by-account / by-vendor views.
--
-- The parent -> super-category map in the UPDATE below is the SQL half of
-- a two-sided canonical map; the JS half lives in
-- src/lib/ingredients/categories.ts. They must stay in lockstep - every
-- future change to one changes the other in the same PR. The seven
-- supers (display order) are: Proteins, Produce, Dairy,
-- Pantry / Dry goods, Prepared & frozen, Bakery, Beverages.
--
-- Applied by Kevin via Supabase SQL editor; CC does not apply.

alter table pr_ingredients
  add column if not exists category text;

-- Backfill the super-category from the existing sub-category. Any parent
-- not in this map (new/unexpected parent, or null parent) leaves
-- category = null, which the queue will surface as "Needs category".
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

-- Verification query for post-apply (run manually; result expected 0+):
--   select parent, count(*) from pr_ingredients
--   where status <> 'merged' and category is null
--   group by parent order by count(*) desc;
-- Any rows surfaced here are "Needs category" and will show in the
-- side-panel queue once that UI lands.

create index if not exists pr_ingredients_category_idx
  on pr_ingredients (category)
  where status <> 'merged';

-- Overview views: split recipe-coverage from resale-coverage.
--
-- food_dollars_linked keeps its name and its "linked = confirmed" filter,
-- but now EXCLUDES items whose linked ingredient has resale = true. The
-- Overview tile keeps rendering - the number it displays is now
-- recipe-only.
--
-- resale_dollars_linked is new: confirmed items whose linked ingredient
-- has resale = true. These are the "tracked" bucket (bottled water,
-- disposables that we buy but don't put in a recipe).
--
-- The join is LEFT so a confirmed row with a stale ingredient_id (should
-- not exist by FK; defensive) still totals into neither bucket rather
-- than failing the view.
--
-- CREATE OR REPLACE VIEW requires preserving existing column names +
-- types in order and only appending; both constraints hold here.

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
  coalesce(sum(usd_12m) filter (where is_food and status in ('active','resale') and link_status = 'confirmed' and (i.resale is false)),0) as food_dollars_linked,
  coalesce(sum(usd_12m) filter (where is_food and status in ('active','resale') and link_status = 'confirmed' and i.resale is true),0)    as resale_dollars_linked
from pr_vendor_items vi
left join pr_ingredients i on i.id = vi.ingredient_id;

create or replace view pr_v_overview_by_account
with (security_invoker = true) as
select a.acct as account_key,
  sum(vi.usd_12m / greatest(1, cardinality(vi.accounts)))                                              as food,
  coalesce(sum(vi.usd_12m / greatest(1, cardinality(vi.accounts))) filter (where vi.link_status='confirmed' and (i.resale is false)),0) as linked,
  coalesce(sum(vi.usd_12m / greatest(1, cardinality(vi.accounts))) filter (where vi.link_status='confirmed' and i.resale is true),0)    as resale_linked
from pr_vendor_items vi
cross join lateral unnest(vi.accounts) as a(acct)
left join pr_ingredients i on i.id = vi.ingredient_id
where vi.is_food and vi.status in ('active','resale')
group by a.acct;

create or replace view pr_v_overview_by_vendor
with (security_invoker = true) as
select vi.vendor_id, v.name as vendor_name,
  sum(vi.usd_12m)                                                                                      as food,
  coalesce(sum(vi.usd_12m) filter (where vi.link_status='confirmed' and (i.resale is false)),0)        as linked,
  coalesce(sum(vi.usd_12m) filter (where vi.link_status='confirmed' and i.resale is true),0)           as resale_linked
from pr_vendor_items vi
join pr_vendors v on v.id = vi.vendor_id
left join pr_ingredients i on i.id = vi.ingredient_id
where vi.is_food and vi.status in ('active','resale')
group by vi.vendor_id, v.name;

-- Grants: unchanged from 0004 (CREATE OR REPLACE preserves them), but
-- re-stated so a fresh db built straight from migrations has them even
-- if 0004 is ever rewritten.
revoke all on pr_v_overview_totals, pr_v_overview_by_account, pr_v_overview_by_vendor from public;
grant select on pr_v_overview_totals, pr_v_overview_by_account, pr_v_overview_by_vendor to service_role;
