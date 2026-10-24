-- 0001_users.sql
-- Seed the two dark-phase curator rows for Kevin and Britt. Apply this in
-- Studio AFTER 0001_potrack_core.sql has succeeded. Idempotent via on conflict.
--
-- These must be lowercase and must match the email Google Sign-in returns on
-- the JWT ("email" claim). The gate middleware lowercases the session email
-- before comparing, and pr_my_role() lowercases before looking up here.
--
-- Change the names only if Kevin wants a greeting that differs from
-- "Kevin" / "Britt"; the policy logic does not read the name column.

insert into pr_users (email, name, role, active)
values
  ('k.fietek@kitchfix.com', 'Kevin',  'curator', true),
  ('britt@kitchfix.com',    'Britt',  'curator', true)
on conflict (email) do update
  set name   = excluded.name,
      role   = excluded.role,
      active = excluded.active;
