-- 0007_review_undo_revoke.sql
--
-- Soft-revoke columns for the review-queue undo path. Hard DELETE is
-- forbidden on pr_ tables (PR24 never-delete - no DELETE grant to
-- service_role in 0002), so undo cannot remove a golden link or a
-- learned alias. The columns below carry a timestamp; "active" means
-- revoked_at IS NULL. Idempotent via `add column if not exists`.
--
-- No new unique index is needed. pr_golden_links already has a plain
-- UNIQUE on (vendor_item_id) (pr_golden_links_vendor_item_id_key) and
-- pr_ingredient_aliases has a plain UNIQUE on (alias_norm, kind)
-- (pr_ingredient_aliases_alias_norm_kind_key). The confirm path upserts
-- on those existing constraints with revoked_at:null in the payload, so
-- a confirm -> undo -> re-confirm cycle mutates the same row in place
-- (revoked_at: now() -> null). No duplicate active rows can exist; no
-- PostgREST partial-unique ON CONFLICT gotcha (docs/GOTCHAS.md #2).
--
-- Future reads that trust "active" must filter revoked_at IS NULL. The
-- Overview coverage already filters by link_status='confirmed' on
-- pr_vendor_items (not on pr_golden_links), so coverage is unaffected
-- by this migration; it continues to count exactly the items whose
-- vendor_item link_status is 'confirmed'. Undo flips the item back to
-- 'proposed' which naturally drops the dollars.

alter table pr_golden_links       add column if not exists revoked_at timestamptz;
alter table pr_ingredient_aliases add column if not exists revoked_at timestamptz;
