# Staging source convergence and connected demo

## Candidate scope

The local readiness branch combines its sandbox, notification, CX reconnect and audited recovery fixes with the certified staging source `227038d2e0c4f5ad848c76b76207e7fb6dd9aa93` (34 commits ahead of the original main baseline). This is a local merge, not a deployment. The running standalone staging Worker has not been replaced.

Merge resolutions preserve the incoming safe error messages, escalation selection, consent labels and CX navigation alongside data-only SSE refresh and delivery recovery. The template never remounts the editor on a stream event. The incoming staging generator already declares the financial locks; duplicate declarations were removed while retaining the audit branch's stricter certification checks.

## Executed evidence

- Dependency installation, production build and TypeScript check passed on the combined source.
- Built Worker HTTP golden demo passed: booking `PS-UAT-MTT3FJ06-171C`, synthetic payment ₹1,899, concurrent duplicate request returns the same booking, provider execution and completion, invoice, balanced ledger and payout accrual. Accrual is not a bank transfer.
- Analytics after that demo: four total bookings, three completed, GMV and collections ₹7,197, no degraded data sources. Customer notification rows remain queued; this is not proof of external delivery.
- Persistent D1 integrity check returned `ok`; foreign-key check returned no violations.
- Native browser retained the search value `E2E` across a Worker stop/restart without a page reload. Delivery recovery and the safe unavailable-consent label remained visible.

The first combined full suite reported 4,728 passing and three failures. Two stale source assertions expected the former inspector grid coordinates and former handoff list variable. The current inspector spans both columns, and handoff selection includes missing escalated threads. Assertions were aligned with those behaviors. The static-test budget failure was fixed by executing the real WhatsApp readiness guard against missing required configuration; the budget was not raised. All targeted follow-up tests passed.

The final combined full suite passed **4,732 tests, zero failures and zero skips** in 274.0 seconds. These are regression results, not a readiness percentage. The exact merge revision is recorded in the delivered candidate manifest.

## Remaining closure

95% human-test readiness is **not certified**. Exact-candidate hosted golden journeys, real sandbox integration receipts, current hosted load evidence, and release/rollback rehearsal remain open. The older hosted performance failure remains relevant as an acceptance gap, but is not a measurement of this combined source. Review the 136-item human readiness checklist and prior evidence reports for each flow's remaining links.

The configured Sites project remains inaccessible (`Sites project not found`). Its manifest ID was preserved; no alternative site or deployment was created.
