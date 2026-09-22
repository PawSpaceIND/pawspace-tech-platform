# PawSpace V2 launch pass — Employee / back-office re-verification (server http://127.0.0.1:8792, commit ad4c56e, PR #960)

Source evidence: `$S/launch/evidence/employee/{founder,roles,people,finance,relocation,followups,followups2,crawl}.json`
(desktop Chromium, founder + 6 personas: jyoti/sunita/vishal managers, anita associate, asha groomer, anjali/mahesh finance)
plus screenshots in the sibling `founder/roles/people/finance/relocation/followups/` directories. Machine records:
`employee.json` (41 items), matrix `employee-matrix.csv`. Re-verifies `$S/findings/employee.json` (EMP-01..EMP-19,
EMP-P01..P13, EMP-NT01) plus the partner-owned SW-023 (OTP 500), which this pass's scripts also re-drove.

## Counts
By status: 12 pass · 9 still-open · 8 fixed-verified · 5 not-retested · 5 defect (new) · 2 env-gated. (41 records total)
By severity: 8 P1 · 17 P2 · 16 "-" (pass/not-retested items with no active severity).

## P0 / P1
No P0s were reproduced this pass.
- **EMP-L-D01 P1 data (new)** — Payroll "Prepare sandbox payment" fails with a D1 schema error `no such column: action` even after a run is correctly calculated → reviewed (different finance actor) → approved. This blocks the last step of Module E on a properly-governed run, which was not reachable at all in the prior phase.
- **EMP-L-R01 (EMP-01) fixed-verified** — `/api/revenue-crm` / Daily Revenue Priority no longer 500s; now 200 with an honest empty ranked list.
- **EMP-L-R02 (EMP-02) fixed-verified** — Seeded managers (jyoti/sunita/vishal) are no longer blanket-refused; each gets CRM/BCC/People inside their own organizational scope, and an honest, specific 403 outside it.
- **EMP-L-R03 (EMP-03) fixed-verified** — Finance now has a working MFA-enrolment UI at `/mfa`; enrolled finance personas can use payroll/finance APIs.
- **EMP-L-R04 (EMP-04) fixed-verified** — `/team/people/payroll` now exposes Review/Approve/Prepare-payment controls; a full calculate→review→approve chain completed via the UI with two distinct finance actors (founder maker, mahesh reviewer, founder approver).
- **EMP-L-R05 (EMP-05) fixed-verified** — `/team/people/time` now has Approve leave / Reject leave / Approve adjustment controls, all driven successfully by a manager.
- **EMP-L-R06 (EMP-06) fixed-verified** — Applying for leave from `/me` now succeeds (200, active policy seeded); an unconfigured-policy case now returns a governed 409, not a 500.
- **EMP-L-R08 (EMP-08) fixed-verified** — `/api/launch-readiness` now authenticates UAT cookie sessions (200, 12 items); Control ▸ Launch essentials loads.

## Still-open prior findings (fresh evidence this pass)
- EMP-07 lead-assignment/SLA governance business-rule calls still 500 (no active policy seeded); an engineering backlog note claims this was fixed elsewhere, but this build still reproduces it deterministically.
- EMP-09 CRM list search still shows "0 shown" although `GET /api/crm?search=` finds the record by phone and by name; detail-card low-contrast pairs persist.
- EMP-10 `/team/whatsapp` still 404.
- EMP-11 narrowed: finance's silent shells are now fixed everywhere tested (including `/control`), but manager's `/control` is still a silent shell (`denied-SILENT`) for all three managers tested.
- EMP-12 `incentives.manage` still granted to no operational role; `/api/i18n` still readable without `settings.manage`. Improved: managers now pass `GET /api/uat-scheduling` (was 403); associate/sales still 403 there despite holding `scheduling.book`.
- EMP-14 `/team/sales` Customer 360 still one unpaginated 23,000px column, 241 buttons.
- EMP-15 BCC live-stream still 500 (not 403) for sunita/vishal/anita/anjali; jyoti (has bookings.manage) 200, asha-groomer correctly 403. A patch is drafted (`launch/emp15-stream-route.patch.md`) but explicitly not applied to this build.
- EMP-17 test-lab banner still present on `/team`/`/crm`.
- SW-023 partially fixed: customer OTP wrong/unknown code now 401/404 (governed); partner OTP wrong/unknown code still 500 (reproduced 4x across two scripts).

## New defects (not in the prior findings)
- EMP-L-D01 P1 data — payroll prepare-sandbox-payment schema error (above).
- EMP-L-D02 P2 backend — governed business-rule refusals across payroll, attendance-leave `decide_leave`, and `control-runtime-switches` still surface as generic HTTP 500 instead of 403/404/400 (maker/checker conflicts, unknown ids, bad input) — a consistent pattern across 3+ APIs.
- EMP-L-D03 P2 auth/backend — founder is refused (403) on `GET /api/subscription-customers` from `/team`; Control ▸ Approvals panel (`GET /api/control-center-operations?mode=approvals`) 500s while `mode=health` on the same endpoint works.
- EMP-L-D04 P2 UI — `/team/relocation`: an associate can see the case queue but its qualify/staff-action buttons fail 403 with no visible denial text (unlike groomer/finance, who get an honest full-page refusal).
- EMP-L-D05 P2 data — manager "Approve adjustment" returns 200 "approved" but an immediate DB read still shows "pending"; replaying the decide call then 500s instead of returning an idempotent result.

## Environment gates (confirmed, not defects)
- RazorpayX test payout still not exercisable (0 seeded partner statements/orders); AI translate/voice remain env-gated as before.
- Relocation: document registration succeeds but `objectStored:false` (no real object storage locally); payment recording is sandbox-only (`liveMoney:false`).

## Owner decisions
None newly surfaced this pass; no policy/price ambiguity was hit in the employee area this run (prior phase's items were UI/backend gaps, not pricing/policy questions).

## Passes (driven browser → API → durable data)
Staff sign-in for all personas; CRM lead capture (201, owner auto-assigned); Customer 360 + governed CX 409; BCC 14 bookings/filters/actions (201s); Control switch STOP/ENABLE round-trip with a correct payload (validation-error 500s tracked as EMP-L-D02); associate/groomer check-in/out + adjustment request; manager leave decisions visible to associate; payroll API + UI maker/checker chain; GST invoice issue+replay, exports governed 409, statutory package, and a fully governed finance expense maker/checker (428 missing If-Match, 403 self-approve, 200 approve, 412 replay, balanced journal); role refusals 403-never-500 for groomer and role-scoped top nav (15/12/6 cards); **new** — the entire Pet Relocation module end to end (lead → duplicate-idempotent retry → staff qualify/vendor → document register/refuse/re-upload/verify → quote issue/accept-with-idempotent-replay → payment → ordered milestones with out-of-order refusal → refund request/resolve → vendor settlement → balanced reconciliation → cross-customer ownership denied), every negative case correctly governed (403/404/409), no 500s anywhere in that module.

## Untested controls / not re-driven this pass
Pixel 7 viewport for employee screens; lead→booking conversion; scheduling Reassign (still no reservations on test dates); exhaustive dead-button sweep; incentive Approve/Reverse/dispute-resolve write actions (buttons present, no seed data to exercise them); pricing-rule/customer-reminder-policy write actions (pages still render, writes not re-posted); Ops work-queue/alerts/cases page-level re-check (only API-level 200s re-confirmed); BCC's new "Tickets & refunds" tab was seen but no cancel/refund write action was driven.
