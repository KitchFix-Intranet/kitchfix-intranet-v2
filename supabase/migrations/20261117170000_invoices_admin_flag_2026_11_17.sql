-- Invoices V2 - the review flag (lane master, ruling 9)
-- Written by Chat-Claude on 2026-11-17. Kevin applies it in Supabase Studio.
-- CC never runs this file. It is in the repo as the record of what was applied.
-- Names removed from this record on 2026-11-17. The applied statements are unchanged.
--
-- What it does, in plain words:
--   Marks five people as invoice reviewers by setting people.is_invoice_admin
--   to true. In V2 this one flag means "sees every site's invoices and can
--   review them". Nothing else is changed.
--
-- What it does not do:
--   No table, column or permission is added. No other row is touched.
--   v1 invoices do not read this column (v1 uses its own fixed list), so v1
--   behaves the same. v1's People access page will show an INV badge on
--   these five.
--   The nightly roster job does not write this column, so the flag stays.
--
-- Checked on the live database on 2026-11-17 before writing:
--   0 people have the flag today. Each of the five ids below matches exactly
--   one ACTIVE row. The people table has no triggers.

-- STEP 1 - look before. Expect: flagged_now = 0
select count(*) as flagged_now from people where is_invoice_admin is true;

-- STEP 2 - look at the five rows. Expect: 5 rows, all ACTIVE, all false
select worker_id, display_name, title, status, is_invoice_admin
from people
where worker_id in (
  '5c13e30292dabb4b9cc1078e',
  '5c13e30129624856a64d4fa6',
  '5c13e301c592912c3a7afea4',
  '6418e1e52a44e07c8b303f7b',
  '5e53e9313ca04e6e44ba3165'
)
order by display_name;

-- STEP 3 - the change. Expect: "UPDATE 5"
begin;

update people
set is_invoice_admin = true
where status = 'ACTIVE'
  and is_invoice_admin is not true
  and worker_id in (
    '5c13e30292dabb4b9cc1078e',
    '5c13e30129624856a64d4fa6',
    '5c13e301c592912c3a7afea4',
    '6418e1e52a44e07c8b303f7b',
    '5e53e9313ca04e6e44ba3165'
  );

-- If the line above did not say UPDATE 5, run "rollback;" and stop.
commit;

-- STEP 4 - look after. Expect: flagged_now = 5
select count(*) as flagged_now from people where is_invoice_admin is true;

-- To undo:
--   update people set is_invoice_admin = false where worker_id in (the five ids above);
