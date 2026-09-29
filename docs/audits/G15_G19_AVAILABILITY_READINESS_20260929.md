# G15–G19 provider availability: audit and first repair

Audit source: `ada600b6df2fb190971c03219d37c55b99823f2a` (#1175), 29 September 2026.
This audit follows the user's G15–G19 issue list. It is not a declaration that those five requirements are complete.
No live scheduling configuration, provider calendar, leave request, booking, payout or notification was changed by this audit.

## Requirement-by-requirement findings

| Requirement | Existing reusable code | Readiness finding |
| --- | --- | --- |
| G15: full-time/contract working hours and existing bookings | `backend/src/scheduling.ts`, `lib/provider-capacity-governance.ts`, dated `scheduling_availability` rows | Partly present. Full-time providers are auto-assigned only after eligibility; commission providers receive offers. Both depend on dated rosters. Employee shift assignments are not read by these matching paths. |
| G16: Apply for leave and define pending status | `lib/attendance-leave.ts`, `app/me/page.tsx`, `lib/workforce-person-linkage.ts` | Employee leave request/independent approval exists. The inspected provider scheduler reads `provider_unavailability`, not `leave_requests`; the employee approval method does not write the provider block. The V2 mobile partner bridge does not expose a complete provider leave flow. |
| G17: commission Open/Blocked calendar | Ops `set_availability`/`block_time` controls; legacy backend `PUT /v1/providers/:id/availability`; authored-row precedence | Ops can publish dated windows or an empty blocked day. The canonical provider endpoint exposes an available/unavailable toggle, not a dated self-service calendar; the V2 partner app does not call the legacy calendar PUT. Overnight matching also ignored an empty or wrong-zone row (fixed by this first repair). |
| G18: eligibility before ranking | Shared scheduler, `scheduling-calendar-reads.ts`, provider verification, radius, conflict and buffer rules | Existing filters precede ranking. This audit reproduced calendar interpretation defects; the first repair below fixes those specific defects, not every end-to-end race/acceptance path. |
| G19: block/leave changes invalidate affected bookings, reassign and notify | Provider recovery cases and existing service recovery/communication modules | The inspected Ops block writer and provider availability toggle do not enumerate affected booked jobs, enqueue reassignment or notify parties. Existing recovery machinery needs an explicit availability-change handoff; no automatic notification completion is claimed. |

The V2 partner entrypoint, `app/v2/partner/page.tsx`, reuses `app/partner-app/page.tsx`; it is not a second provider engine.
`workforce-classification.ts` separates direct employees, contract providers and commission providers. Contract-provider People linkage must not create employee salary or duplicate commission payout authority.
Active employee HR/payroll work in PR #1176 is separate and was left untouched.

## Reproduced calendar defects

The original engine admitted Boarding and overnight Sitting when an authored row existed but had **no open windows**, was for **another zone**, or contained **invalid clock values**. A preferred/repeat provider bonus did not compensate for that missing eligibility gate.
Appointment matching reduced start/end to clock minutes; a cross-midnight visit could therefore appear to fit daytime-only rows. It also discarded seconds/milliseconds and demanded a new date row for visits ending exactly at midnight.
The new diagnostic selection first produced **13 failing cases / 10 passing controls** on the unmodified scheduler. These are synthetic execution tests, not observations of customer bookings.

## First repair: shared eligibility, not a new scheduling engine

- A stay day now needs at least one valid open window in the requested zone; an empty, malformed or wrong-zone row is not availability.
- Appointment coverage is checked separately for every occupied local date, retaining fractional minutes. Midnight is the preceding day's `24:00` endpoint; a visit's end is exclusive.
- Published clocks are validated (`00:00`–`23:59`, with `24:00` permitted only as an end); reversed/zero-width windows do not qualify.
- If a repository returns both authored (`partner_app` / `operations` / `roster`) and synthetic availability for the same provider-date, the authored rows are authoritative; synthetic UAT rows cannot widen them.
- Valid normal appointments, real cross-midnight windows, full-time automatic assignment, commission offers, preferred-provider rules, explicit leave, capacity, travel buffers and ranking weights retain their existing behavior.
- Existing Boarding/overnight Sitting **day-level** availability semantics are retained: this patch does not reinterpret a host's open day as a new 24-hour shift or change checkout-day policy.

`tests/provider-calendar-eligibility.test.mjs` executes the actual shared scheduler, including mixed authored/synthetic authority cases.
`tests/provider-calendar-reservation.test.mjs` executes the real Ops publish and reservation routes against SQLite through the existing D1 adapter. It verifies blocked stays create no reservation or offer, while valid stays still reserve and generate the original commission offer. External requests are forbidden in those fixtures.
Early route-fixture attempts omitted mandatory named-host selection and expected a generic rather than selected-provider refusal code. Those fixture issues were corrected; they were not counted as application failures.

## Remaining implementation and acceptance

1. Link provider working schedules and People leave to the canonical availability authority without reclassifying contract providers into salary payroll.
2. Add ownership-scoped provider calendar/leave UI and API flows, reusing canonical rows and permissions rather than creating another matching engine.
3. Add an idempotent availability-change recovery handoff for booked jobs, preserve existing bookings while alternatives are checked, and notify only through approved communication rules.
4. Verify changing calendars between preview, reservation and booking confirmation; this first calendar-parser repair does not claim those race paths are closed.
5. Validate timezone normalization in every legacy leave/recovery query, not just the shared preview calendar reader.
6. Execute authenticated hosted tests for the full provider journey; offline engine/route tests are not hosted acceptance.

**Policy decision still required by the original G16 scope:** does requested provider leave block new assignments immediately, or only once approved? The current employee leave module uses independent approval; this audit does not silently make that policy the rule for provider dispatch. Pending leave must have an explicit, visible assignment rule.

## Verification and release boundary

The exact final verification results are recorded in the associated PR and the authorized Mac evidence folder `g15-g19-availability-audit-20260929-evidence/`.
No fixture was deleted, no eligibility threshold was loosened, and no financial or live-environment setting was changed.
Merge, shared-staging deployment and complete G15–G19 acceptance remain separate gates.
