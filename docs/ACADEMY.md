# Academy - engine map (train A)

The Academy ships in four trains. This repo currently contains the
engine (train A); the surfaces (room, library, records, focus) arrive
in trains B through E after their renders are approved. Point at
`claude/ACADEMY_V2_ALIGNMENT_2026-10-25.md` for the surfaces plan.

## Files in `src/lib/academy/`

- `identity.ts` - `resolveAcademyIdentity(email, { supa })`,
  `eligibleCountInScope(identity, { supa })`,
  `canSeeStandingCard(identity, opts)`,
  `canSeeHourlyRoster(identity, opts)`. One function answers "who
  is this signed-in person and what Academy scope do they hold?"
  Allowed sources: `people` (joined on `work_email` with
  `status='ACTIVE'`), `accounts`, `academy_person_stints`,
  `academy_eligibility_exceptions`, `academy_grants`,
  `academy_region_leads`. Forbidden sources: `contacts.role`,
  `src/lib/admin.js` allowlists, `user_accounts_derived`,
  `user_accounts_manual`. A duplicate active `people` row for one
  email is a defect, not a fallback - the resolver logs loudly and
  returns `null`. Scope precedence (strict, first-match):
  `academy_admin` -> company; email in `academy_region_leads` ->
  region; `people.is_site_leader` -> site; otherwise self.
- `requirements.ts` - the issuance engine. `evaluateEligibility`,
  `validateAudienceScope`, `evaluateCycleScope`, `planCyclePublish`
  + `applyCyclePublish`, `planOnboarding`, `planRehire`,
  `applyRequirements`. Nothing in train A calls these; they exist
  for train E. One `evaluateEligibility` is the single source of
  truth so cycle publish, onboarding, and rehire can never drift.
- `room.ts` - `loadRoom(email, supa?)`. Powers `/api/academy/room`.
  Returns viewer identity, queue (requirements enriched with doc +
  obligation + cycle), queueSummary, yearTrack, nextCycle, and -
  for company/region scope only - companyStanding.
- `library.ts` - `loadLibrary(email, supa?)`. Returns the active
  document catalogue grouped by shelf, plus the per-doc "trains
  you" marker.
- `records.ts` - `loadRecords(email, supa?)`. Ledger surface - the
  viewer's signatures / waived / outstanding, and (for
  `academy_admin` holders only) the company-wide signatures view.
- `module.ts` - `loadModule(email, requirementId, supa?)`. Returns
  everything the Focus view needs: doc meta, pre-rendered HTML,
  step boundaries (600 words per step; descends when a parent
  heading runs long; merges undersized descended siblings), the
  approved questions WITHOUT `correct_option_id`, the viewer's
  attempt summary, any existing attestation, and the resume-at
  index.
- `attestation.ts` - `buildAttestationSentence({ displayName,
  moduleTitle, documentTitle, version })`. Server-side only. The
  sign handler calls this and ignores any client-supplied
  attestation text.
- `certificate.ts` - `createCertificatePdf({ attestation, doc,
  obligation })`. Server-only pdf-lib dependency. The certificate
  prints the VERBATIM `attestation_text` stored on the row and
  reports attempts honestly - if it took three tries, it says
  three. Date formatting goes through `Intl.DateTimeFormat` with
  an explicit `en-US` locale (handler returns are ISO strings; the
  PDF is the one presentation layer that must render a date).

## Routes under `src/app/api/academy/`

Every route starts the same way:

```ts
const g = await requireOwnerApi();
if (g instanceof Response) return g;
// g.email is lowercased by sessionEmail()
```

A signed-in `kitchfix.com` account not in `OWNER_EMAILS` gets 404
from every one of these (DESIGN.md battery item 12).
Unauthenticated requests get 401 from `src/proxy.ts`.

| Route | Method | Response | Gate |
|---|---|---|---|
| `/api/academy/whoami` | GET | JSON | owner |
| `/api/academy/room` | GET | JSON | owner |
| `/api/academy/library` | GET | JSON | owner |
| `/api/academy/records` | GET | JSON | owner |
| `/api/academy/module/[requirementId]` | GET | JSON | owner + requirement must belong to viewer |
| `/api/academy/check` | POST | JSON | owner + requirement must belong to viewer |
| `/api/academy/progress` | POST | JSON | owner + requirement must belong to viewer |
| `/api/academy/sign` | POST | JSON | owner + five gates + displayName match |
| `/api/academy/certificate/[attestationId]` | GET | application/pdf | owner + (owner-of-attestation OR `academy_admin`) |

### Append-only tables

Two tables see INSERT from this code and never UPDATE or DELETE:

- `academy_attestations` - the signature ledger. A row is permanent
  once written. The database refuses UPDATE / DELETE / TRUNCATE on
  this table for the service role; adding a code path that would
  try is a defect.
- `academy_check_attempts` - every attempt, right or wrong, is
  evidence. Same refusal grants as attestations.

The sign handler is idempotent on primary-key conflict for
`attestation_id`: the client generates the UUID before submitting;
if the row already exists, the handler returns 200 with the
existing row. This covers dropped-connection retries without
double-signing.

### correct_option_id never leaves this engine

`correct_option_id` on `academy_questions` is server-only. The
`module.ts` loader uses an EXPLICIT column list that OMITS the
column; the only query in the codebase that reads it is the grader
inside `check/route.ts`, and the value is compared in memory and
never returned to the caller. A grep across `src/app/api` +
`src/lib/academy` for the string MUST return only that grader + the
comment block explaining the trap. A refactor that swaps the module
loader to `select("*")` would leak every answer in the system.

### Test signatures are never written against a real person

The sign route IS the one route that lands a signature. A test run
that reaches a successful `/api/academy/sign` INSERT against a real
owner email writes a permanent row in `academy_attestations` that
cannot be deleted (the append-only grants refuse DELETE even to
service_role). Probing the sign gates is a train-A deliverable;
reaching a successful sign is NOT. Live pilot signatures happen in
train C with Kevin as the first signer.

## Parity probe

`scripts/_academy_parity.ts` runs the v1 route handlers against the
same database (via subprocess, inside a sibling v1 clone) and the
v2 TS loaders in-process, diffing per surface. Known ignorable
fields: `last_seen_at`, `started_at`, `rendered_at`, `issued_at`,
`attempted_at`, and `module.questions[*].options` order (shuffled
server-side per request). Any other difference between v1 and v2 on
the same email is a port error.
