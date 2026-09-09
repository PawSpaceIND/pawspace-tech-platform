# Admin booking read consistency and query fan-out

The canonical admin booking endpoint previously ran one list query plus two child queries per booking: up to 201 data queries and 100 sequential child-fetch rounds for a 100-row page. Because those reads were separate, a provider completion could appear in the returned lifecycle events while the returned booking status still reflected the earlier state.

The endpoint now reads the bounded list, pets and events in one D1 transactional batch of three statements. All statements use the same bounded selection. Pet membership and customer ownership checks remain enforced; event fields and response shape are retained. Stable ID tie breakers make equal timestamps and names deterministic. An index on booking creation time and ID supports the recent-booking selection.

## Evidence

- 23 targeted tests passed, including gateway authorization, schema checks and three new executing list tests.
- The 105-booking fixture proves the 100-row limit, child ownership, excluded older bookings, ordering, payment details, and one batch containing three statements.
- A real SQLite WAL test commits a provider completion through a second connection between the list and child reads. The first response stays internally consistent; the next read sees both the completed status and completion event.
- Build and typecheck passed.
- The built Worker returned HTTP 200 with all four existing demo bookings. Every returned pet and lifecycle event matched the persisted database. Booking `PS-UAT-MTT3FJ06-171C` remained completed.
- EXPLAIN on the persisted database confirms `idx_canonical_bookings_created` serves the recent-booking ordering.

The gateway test adapter was corrected to return rows for SELECT statements in D1 batches and to wrap batches in a transaction. The first targeted invocation of schema tests lacked their required NODE_ENV=test binding; rerunning with the declared sandbox test environment passed without weakening those checks.

These are local correctness and query-count results. The prior 4,732-test full-suite result belongs to parent revision `322d1ec0`; it was not rerun for this narrowly scoped change. No hosted latency improvement, provider receipt, deployment or 95% readiness certification is claimed.
