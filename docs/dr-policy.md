# PawSpace D1 Disaster Recovery Policy

## Scope and objectives

This policy covers Cloudflare D1 operational recovery for PawSpace. It is intentionally independent of application migrations and API code. Production recovery is executed only by an authorized incident commander; automated drills must use an isolated database whose name is explicitly classified as DR, UAT, test, or sandbox.

- **RPO (Recovery Point Objective): < 1 minute.** PawSpace relies on D1 continuous Time Travel history and captures a pre-change bookmark immediately before destructive or high-risk operations. A drill passes only when the measured interval between the protected canary write and the captured recovery bookmark is under 60 seconds.
- **RTO (Recovery Time Objective): < 5 minutes.** A drill passes only when bookmark restore plus post-restore integrity verification completes in under 300 seconds.
- **Recovery truth:** a restore is not complete when Wrangler exits successfully. PawSpace must query the restored database and prove the expected rowset/checksum matches the pre-failure baseline.

Cloudflare D1 Time Travel operates on remote D1 databases. The local D1 emulator is useful for application tests but cannot certify remote Time Travel recovery.

## Blast-radius isolation

1. Production/live/golden database names are denied by the automated drill harness.
2. Drills run only against dedicated ephemeral DR databases or explicitly isolated UAT/test/sandbox databases.
3. The harness refuses to overwrite a pre-existing `__dr_drill_canary` table.
4. The drill records an original bookmark before any mutation, creates a timestamped canary, records a second pre-corruption recovery bookmark, destroys only the canary, restores to the recovery bookmark, and proves exact state equality.
5. After proof, the harness restores the original bookmark so the test database returns to its pre-drill state.
6. Any failed drill is treated as an incident: no production restore is attempted from the failed automation path until the failure is diagnosed.

## Recovery procedure

1. Freeze mutating jobs for the affected database and record the incident start time.
2. Identify the last known-good timestamp/bookmark and independently verify the target database name/UUID.
3. Record current D1 Time Travel information before restore.
4. Execute `wrangler d1 time-travel restore <database> --bookmark <bookmark>`.
5. Run integrity probes for critical tables, row counts, financial invariants, and representative business records.
6. Re-enable writers only after recovery verification and incident-commander approval.
7. Record measured RPO/RTO and attach terminal evidence to the incident record.

## Dual-region continuity architecture

D1 is a Cloudflare-managed database service rather than a customer-managed two-node SQL cluster. PawSpace therefore treats dual-region resilience as a **logical primary/standby topology**, not as native multi-writer replication:

- **Primary:** the active PawSpace D1 database, with Time Travel providing point-in-time rollback for logical corruption.
- **Standby:** a separately provisioned D1 database in a geographically distinct location class, kept ready for controlled restore/import and application binding cutover.
- **Control plane:** database identifiers, restore bookmarks, last verified export/checkpoint, and cutover state are recorded outside the affected database.
- **Failover:** freeze writes, restore/import the verified recovery point to the standby, validate invariants, then switch the application binding/configuration through the normal reviewed deployment path.
- **Failback:** after the original primary is repaired, perform the same validation and controlled cutover in reverse; never attempt dual writes during recovery.

Time Travel is the primary logical-corruption recovery mechanism. The geographically distinct standby is a separate continuity layer for larger blast-radius events; it must not be represented as synchronous D1 multi-region consensus unless Cloudflare explicitly provides and PawSpace has enabled such a product capability.

## Drill acceptance criteria

A Blocker 2 drill is successful only when all of the following are true:

- isolated target classification passes the production-deny guard;
- original and pre-corruption Time Travel bookmarks are captured;
- canary creation and destructive drop are both observed remotely;
- restore returns the exact canary token, timestamp, and checksum;
- baseline and recovered canonical rowset SHA-256 digests are identical;
- measured RPO is `< 60s` and measured RTO is `< 300s`;
- cleanup restores the database to its original pre-drill state;
- the script exits `0` and repository integrity checks remain clean.
