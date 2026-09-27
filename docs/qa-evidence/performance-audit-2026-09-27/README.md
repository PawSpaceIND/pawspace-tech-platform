# Performance audit remediation — staging only

This change addresses gaps left uncovered after checking open PRs #1130 (web chat speed/OTP), #1123 (voice sales), #1125 (training payment return) and #1126 (reporting presentation). It does not claim production certification or matching Uber/Swiggy.

- Home publishes availability independently of identity/account reads.
- Company analytics uses the existing scheduled-start index while retaining inclusive date-prefix semantics. IN-list reads retain all results with four concurrent chunks per invocation.
- AI analytics batches nine reads in one round trip and caches successful schema initialization per binding. Booking-linked threads share the turn filters. Independent operational ledgers remain explicitly labeled all-time/all-channels. Latency shows its recorded sample count, and previous-filter data is hidden during refresh/error.
- Finance API and screen explicitly identify latest-200 ledger scope; chart filters remain independently labeled. No totals are fabricated, and no unbounded ledger fetch is introduced.
- The performance gate enforces every operation separately; fast ledger traffic cannot hide slow booking/assignment samples.
- Optional `performance_audit` on the existing isolated deployment workflow records 10 authenticated full-response observations per selected API after exact-build certification. These are small CI-runner samples, not field metrics or a load test.

Executable regressions cover unresolved identity, unresolved availability, identity failure, bounded concurrency/order, D1 failure propagation, missing/slow operation gates, real SQLite report filters and index usage. Existing UI-preservation snapshots are refreshed only for this change's reviewed paths.

Outstanding audit boundaries: customer browser checkout and assignment acceptance, real-device CWV, actual microphone/carrier response and interruption, sustained load/soak, and production integration readiness. Missing GST publication remains a governed Finance prerequisite; no rate or policy was invented. Existing voice/chat PR owners retain their work.
