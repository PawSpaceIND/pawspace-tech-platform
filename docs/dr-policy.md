# PawSpace D1 Disaster Recovery Policy

## Scope and objectives

This policy covers recovery of PawSpace Cloudflare D1 data after destructive writes, operator error, or database corruption. It is intentionally independent of application schema changes and must not be used to modify product tables during a drill.

- **RPO target:** less than 1 minute. D1 continuous Time Travel history is the recovery source; the responder captures a current bookmark immediately before any controlled destructive drill and records the UTC timestamp.
- **RTO target:** less than 5 minutes from declared recovery point to restored integrity proof for the isolated database.
- These values are PawSpace operational objectives. If the provider cannot return a qualifying bookmark or restore inside the target window, the drill fails and the database is not certified for freeze.

## Blast-radius isolation

Every destructive drill must run against a dedicated local, preview, test, sandbox, or UAT database. Shared staging and production databases are forbidden. The drill harness rejects names that look like production/live/primary databases and requires an explicit `DR_D1_ISOLATED=1` acknowledgement for remote D1 mode.

The only object created by the drill is `__dr_drill_canary`. The harness never reads, writes, migrates, or restores individual PawSpace application tables. A remote Time Travel restore is database-wide, so the target D1 instance must be disposable and isolated from concurrent product traffic.

## Recovery point and evidence

For remote D1, the harness records the start timestamp, seeds a unique canary token, then obtains a D1 Time Travel bookmark representing the pre-destruction recovery point. Evidence must include the database name, UTC timestamp, bookmark, token SHA-256, destructive action, restore action, recovered token SHA-256, integrity result, elapsed recovery time, and cleanup result.

For local deterministic validation, the harness uses a disposable SQLite database and an exact pre-destruction snapshot as a PITR simulation. This proves the orchestration and mathematical canary comparison without claiming that SQLite itself implements Cloudflare Time Travel. Remote D1 certification must use the real bookmark path.

## Failover runbook

1. Declare the affected database and freeze writers to that isolated environment.
2. Identify the last known-good UTC timestamp and retrieve the matching D1 Time Travel bookmark.
3. Record the bookmark and incident ID before executing any restore.
4. Restore the isolated database with `wrangler d1 time-travel restore <db> --bookmark <bookmark>`.
5. Run deterministic integrity queries and compare expected canary/business invariants.
6. If proof fails, keep writers frozen, select the preceding known-good bookmark, and repeat. Never advance an unverified database.
7. After proof succeeds, remove drill canaries, verify integrity again, record RPO/RTO evidence, and only then reopen writers.

## Freeze gate

Blocker 2 is green only when the automated drill exits `0`, the pre- and post-restore token hashes are identical, database integrity reports healthy, cleanup is complete, `git diff --check` passes, and TypeScript validation passes. Remote production recovery remains a separately authorized incident action; this drill never authorizes a production restore.
