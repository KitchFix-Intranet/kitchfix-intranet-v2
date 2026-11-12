# People Portal (lane doc)

Short lane doc. The design master is `PEOPLE_PORTAL_V2_MASTER.md` (not in
the repo). This file is the implementation note: what T2 built, where the
rules land in code, what is inert, and the one open migration gap.

## What is built (T2, 2026-11-11)

- `/people` is My team. Owner-only (`requireOwnerPage`). Read-only.
  No forms, no sends, no notices.
- Scope: four rules (corporate / regional_director / site_leader /
  site_manager), server-enforced in `src/lib/people/scope.ts`.
- Roster + search + site switch (desktop) + phone layout.
- Person card (drawer on desktop, full-screen on phone) via
  `?card=<worker_id>`. Scope is enforced on the card too (pin 1); a
  person outside the viewer's scope returns `notFound()` from the
  server, with or without `?as=`.
- Owner preview: `?as=<worker_id>` swaps the viewer wholesale. It
  grants nothing, only narrows. A slim banner names the override and
  links back to `/people`.
- History (R-PP54): calendar-year, final-status only, gated by
  `pp_full_access`, `pp_review`, direct/transitive reports chain, or
  "viewer sent it" (narrowed to only own rows).

## Scope rules as implemented

Role order (pin 2, 2026-11-11): `is_regional_director` is tested BEFORE
`is_corp` because both are `is_corp=true` on the row. See
`resolveRole()` in `src/lib/people/scope.ts`.

| Viewer | Sees |
|---|---|
| Corporate (`is_corp` and not RD) | Everyone |
| Regional director (`is_regional_director`) | Every site in their region, and corporate |
| Site leader (`is_site_leader`) | Their site, salaried managers included |
| Site manager (salaried, not the leader) | Themselves and the site's hourly people only |

- Account region joined via `accounts.region` on `people.account_key =
  accounts.team_key`. People.region is NOT read on site rows (it is
  null; the RD's own region is read from their own people.region row).
- Everyone sees their own card (pinned first in the list).
- `status = 'ACTIVE'` only.

## Viewer lookup (seasonal-rehire discipline + PII posture)

Mirrors `src/lib/academy/identity.ts` in behaviour; cross-lane
import is disallowed, so the rules are duplicated here in
`src/lib/people/viewer.ts`:

- The join to `people` REQUIRES `status = 'ACTIVE'`. 142 of the
  humans on the roster hold more than one `worker_id` row because
  seasonal staff are rehired under a new stint each season while
  keeping the same `work_email`. Without the `ACTIVE` filter, a
  single login resolves to multiple rows.
- If MORE THAN ONE active row still matches a signed-in email
  (or the `?as=<worker_id>` override), that is a defect, not a
  fallback. `resolveViewer()` logs the email + worker_ids loudly
  via `console.error` and returns `null`, so the page renders the
  "You are not on the roster yet" empty state instead of silently
  picking one row and leaking the wrong scope.
- `personal_email` and `phone` are NEVER selected in the viewer
  query or the roster query (`VIEWER_SELECT` in `viewer.ts`,
  `PEOPLE_SELECT` in `load.ts`, and the scope-check projection in
  `page.tsx`). Only the card query (`PERSON_SELECT` in
  `loadPerson.ts`) pulls them, and the single mapper
  `toCardPerson()` applies the R-PP10 gate immediately. The
  `PeopleRow` TypeScript shape marks those columns optional for
  that reason: their presence is the exception (card path), their
  absence is the norm.

## Contact rule (R-PP10)

Enforced in exactly one place: `src/lib/people/contact.ts`.

- `toRosterPerson()` returns a row for lists/search. It never carries
  `personal_email` or `phone`. The TypeScript shape (`RosterPerson`)
  does not have those fields at all; the compiler keeps us honest.
- `toCardPerson()` is the only mapper that can produce fields with
  personal_email / phone semantics. Applies:
  - Work email: shown for anyone who has one.
  - Personal email: only when the person has no work email AND is not
    salaried. `personal_email_for_display` is null otherwise.
  - Phone (salaried): printed, via `phone_for_display`.
  - Phone (hourly): `phone_for_display` is null; `phone_href` carries
    the digits and only ever reaches the DOM inside a `tel:` or `sms:`
    `href` attribute. Never as visible text. Never in roster payloads.

## What is inert in T2

- The four quick-action doors (Inbox / New Hire / PAF / Incident).
  Rendered with `aria-disabled` and the shared line "Coming with its
  own build step". No `href`. No navigation.
- The card's two buttons (PAF for this person / New request). Same
  pattern.
- The topbar @-slot keeps the v1 "Open People Portal" link so the way
  to the live portal is not lost.

## Hourly non-manager viewer

Spec names four roles. An hourly non-manager person isn't any of
them. They can only land in this state via `?as=<worker_id>` owner
preview. Empty-state copy reads "Nobody to show for this person."
(Kevin ruling 2026-11-11.)

## Manager chain

`manager_name` renders the name only. No link, no card trigger (pin 4).
The chain walker in both `loadPerson.ts` and `visibleHistory` guards
against degenerate cycles (self-manager row, A->B->A loops) with a
seen-set.

## Dates (R-PP59, pin 5)

- Rows: "Nov 9" via `fmtShort(iso)`.
- Card: "Nov 9, 2026" via `fmtFull(iso)`.
- "N days" is ONLY for how long a request has waited, via
  `fmtDaysWaiting(iso)`. There is no `fmtDaysAgo` helper.

## Migration gap

Four People v2 migrations were applied in Studio on 2026-11-11
(`people_v2_01` to `people_v2_04`). Their SQL is NOT in
`supabase/migrations/` yet. That is a separate small follow-up with
the exact SQL from Chat-Claude. This train writes nothing and runs
no SQL. The code reads live columns that already exist
(`pp_full_access`, `pp_review`, `is_regional_director`,
`incident_backup`).

## File footprint

- `src/app/(shell)/people/page.tsx`
- `src/app/(shell)/people/loading.tsx`
- `src/app/(shell)/people/people.css`
- `src/components/people/MyTeam.tsx`
- `src/components/people/PersonCardFrame.tsx`
- `src/components/people/PersonCardBody.tsx`
- `src/components/people/QuickActions.tsx`
- `src/components/people/OwnerPreviewBanner.tsx`
- `src/lib/people/types.ts`
- `src/lib/people/scope.ts`
- `src/lib/people/viewer.ts`
- `src/lib/people/contact.ts`
- `src/lib/people/load.ts`
- `src/lib/people/loadPerson.ts`
- `src/lib/people/dates.ts`
- `docs/PEOPLE.md`
- `docs/LEDGER.md` (one line under People Portal)
- `src/app/(shell)/layout.tsx` (one-line title/crumb change - the
  only edit outside the People lane).
