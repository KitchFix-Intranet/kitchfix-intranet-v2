-- 0002_potrack_grants.sql
-- The v2 app reads AND writes every pr_ table through the service-role server
-- client (src/lib/supabase/service.ts). 0001 granted the pr_ tables to
-- `authenticated` only, never service_role, so every service-role query returns
-- 42501 "permission denied for table ...". The Ingredients overview surfaced it
-- as a 500 (digest 3639478472); Home swallowed it in a try/catch and rendered
-- empty. pr_v_invoice_lines was already granted to service_role in 0001.
--
-- SELECT + INSERT + UPDATE on all 13 pr_ tables. NO DELETE: the schema invariant
-- (0001 header) is that the app never deletes ingredient / vendor-item rows;
-- duplicates are soft-flagged via UPDATE (status='duplicate'). RLS and the
-- `authenticated` grants from 0001 are left untouched; service_role bypasses RLS
-- and the owner gate is the real lock during the dark phase.

grant select, insert, update on
  pr_users,
  pr_vendors,
  pr_vendor_aliases,
  pr_vendor_items,
  pr_vendor_item_aliases,
  pr_ingredients,
  pr_ingredient_aliases,
  pr_ingredient_yields,
  pr_price_observations,
  pr_golden_links,
  pr_coverage_snapshots,
  pr_events,
  pr_intake_runs
to service_role;
