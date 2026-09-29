# PawSpace V2 — Founder visual-audit repairs

## Scope

This change implements repairs for the 27 findings in the 28 September Founder UI audit. It is not an application-wide 100% sign-off. The earlier 28 customer/partner observations remain a separate, unverified register.

The primary browser matrix now opens the actual `/v2` staff routes, including the V2 layout and its style overrides. A separate canonical-route check preserves the shared `/team` screens. No route wiring, API implementation, library business rules, pricing calculations, permission definitions or database source is changed.

The original repair base is `d8ad4a321cc6277b072c82fb1297f4cad0af9dc4`, which includes merged #1140. The reviewed presentation-delta JSON records each existing UI file's before/after hash and the new display components. Final candidate and CI status are recorded below when verified.

## Repairs and browser evidence

| Finding | Repair | Focused coverage |
|---|---|---|
| F-001 | Reminder records remain readable inside horizontal scroll regions | V2 table matrix |
| F-002 | Meet & Greet labels/actions no longer fragment | V2 table matrix |
| F-003 | Finance ledger preserves complete words and amounts | V2 table matrix |
| F-004 | Voice action labels remain readable | V2 table matrix |
| F-005 | WhatsApp template values/actions remain readable | V2 table matrix |
| F-006 | Lifecycle rows retain readable rule/status text | V2 table matrix |
| F-007 | Subscription-plan prices and labels do not fragment | V2 table matrix |
| F-008 | Reconciliation's final columns remain reachable | V2 table matrix |
| F-009 | GST tables scroll within their actual parent, including article elements | V2 table matrix |
| F-010 | Training configuration buttons wrap as complete controls; explanatory text gets its own row | Three widths; word bounds, button heights and tables |
| F-011 | Provider panels stack; long audit identifiers remain contained | Three widths, including 768-pixel tablet |
| F-012 | Appearance moves into a hydrated, static staff utility slot | All table routes; appearance dialog open/close |
| F-013 | Roster Remove actions retain adequate width | Three populated roster views |
| F-014 | Control's Action required badge occupies an intact mobile row | Three widths; semantic critical state |
| F-015 | Quick-range selection retains its complete line | Mobile combobox width and wrapping |
| F-016 | Atlas renders escaped text with emphasis, code and visible list markers | Three widths; literal markup stays text |
| F-017 | Live Tracking uses the selected shared palette | Three widths, three palettes, two modes and two styles |
| F-018 | Tracking panels fill their columns without stretched empty cards | Bounded 45-session list and card geometry |
| F-019 | Long master lists no longer stretch companion detail columns | 80 handoff threads; CRM and pricing scroll bounds |
| F-020 | Attendance headers and states retain readable table sizing | Populated employee display at three widths |
| F-021 | Leave date fields retain usable width | Date inputs at three widths |
| F-022 | Marketing fields have persistent visible labels | Exact accessible field labels |
| F-023 | Wallet lookups have customer/booking labels and complete instructions | Labels and visible instruction text |
| F-024 | Empty TDS headers remain a coherent horizontal table | Populated and empty six-column states |
| F-025 | Empty People Finance sections show explicit descriptions | Empty only after successful loading |
| F-026 | Cadence-policy input baselines align | Tablet and desktop input geometry |
| F-027 | Boarding Finance actions share consistent alignment | Variable-length queue rows at three widths |

The additional Atlas status-card overflow found during retesting is also corrected. The complete status value remains visible within its card; it is neither hidden nor replaced.

## Unchanged business wiring

45 independent checks preserve original request/action/field bindings, state and calculation code, and text-rendering safety. The expected program signatures come from the pre-repair commit, not from the modified implementation. Two display components intentionally add local utility-slot state; their original interaction bindings remain checked, and the appearance component cannot introduce network calls or identity-storage writes.

The older snapshots were reviewed against `UI_AUDIT_REVIEWED_PRESENTATION_DELTA_20260928.json`. Only the listed UI source references changed. The existing assertions and mutation-rejection checks remain active. The StaffWorkspace correction is explicitly reversible through five small edits, and the original Control stylesheet is reconstructable before the scoped append. No test helper substitutes a different source for the file under test.

## Verification record

The canonical-route matrix passed 59 tests before the last Training control refinement. The stronger Training word-bound/height checks and empty TDS checks subsequently passed at all three widths. The actual V2-entry pilot also passed. The final complete V2 matrix, production build and repository CI remain pending until the final verification entry is added below.

Run the UI matrix with `PW_UAT_SERVICE_DATE=2026-10-05 npx playwright test --config playwright.ui-audit.config.ts`. It refuses non-local origins, uses one worker per runner and zero retries. CI distributes independent tests across two shards without raising the 20-minute job deadline. Root theme, mode and style attributes are checked, rather than assuming that a stored preference was applied.

Run the original-program checks with `node --test tests/ui-audit-closure.test.mjs`. Existing repository checks remain required separately.

The browser harness seeds synthetic local identities. Display fixtures do not create bookings, payments, payroll runs, approvals, outbound calls or messages. Training's display data is explicitly mocked so an unseeded local table cannot masquerade as a completed functional test. These visual checks are not certification of tax calculations, real payment execution, carrier calls or production role permissions.

## Remaining application-wide audit

The 27 repairs do not close the earlier customer/partner register. Remaining work includes all customer wizard/checkout outcomes, Partner Jobs/GPS/Earnings/More and service-specific states, internal Control sections and dialogs, separate authenticated role sessions, populated record/approval workflows, and physical-device keyboard/zoom/orientation states. The exact hosted release candidate also needs retesting after the standard release gates pass.

No production or shared-staging mutation or deployment has been made by this repair branch. No live money or outbound customer communication was initiated.
