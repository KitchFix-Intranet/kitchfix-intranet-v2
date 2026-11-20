-- 20261120090000_library_l4_suggest_an_edit.sql
--
-- Record-only for Library L3 + L4. Applied by Chat-Claude on
-- 2026-11-20 on Kevin's instruction, under the migration name
-- `library_l4_suggest_an_edit`; not applied in Studio. This file
-- carries the applied SQL word for word so the next clean apply
-- replays what prod already has.
--
-- Columns added on `public.document_issues`:
--   section_key       - anchor slug of the section a reader picked
--                       when they sent the note. Null = the whole
--                       document.
--   section_title     - heading text for section_key, looked up on
--                       the server from the current document body
--                       at write time. A client cannot rename a
--                       section through this field.
--   doc_version       - the document's version at the time of the
--                       note, so a later reviewer can tell notes on
--                       today's version from tomorrow's.
--   suggested_text    - the reader's optional rewritten wording.
--   handled_by        - owner email who closed the note.
--   handled_at        - when they closed it.
--   handled_outcome   - 'used' or 'no_change' (or null while open).
--
-- Also: one check constraint on handled_outcome, one covering index
-- on (doc_id, status), and the service-role grants the write path
-- and owner list need.

alter table public.document_issues add column if not exists section_key   text;
alter table public.document_issues add column if not exists section_title text;
alter table public.document_issues add column if not exists doc_version   text;
alter table public.document_issues add column if not exists suggested_text text;
alter table public.document_issues add column if not exists handled_by   text;
alter table public.document_issues add column if not exists handled_at   timestamptz;
alter table public.document_issues add column if not exists handled_outcome text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chk_issue_outcome') then
    alter table public.document_issues
      add constraint chk_issue_outcome
      check (handled_outcome is null or handled_outcome in ('used', 'no_change'));
  end if;
end $$;

create index if not exists document_issues_doc_status_idx
  on public.document_issues (doc_id, status);

grant select, insert, update on public.document_issues to service_role;
