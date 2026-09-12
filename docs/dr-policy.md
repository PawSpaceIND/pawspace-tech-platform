# PawSpace D1 Disaster Recovery Policy

## Scope

This policy covers Cloudflare D1 recovery for PawSpace application databases. The destructive Time Travel drill is permitted only against the isolated UAT database `pawspace-staging`. Production (`pawspace-prod-bengaluru`) must never be used for a destructive drill.

This runbook does not modify the `app_users` schema and does not touch DPDP migrations.

## Recovery objectives

- **RPO (Recovery Point Objective): < 1 minute.** For an incident, restore to the newest safe D1 Time Travel bookmark captured immediately before the destructive event or to the newest safe point identified during incident response. The drill records the exact bookmark before corruption and verifies restoration to that point.
- **RTO (Recovery Time Objective): < 5 minutes.** The database must be restored and verified within five minutes of beginning the restore procedure. Measure wall-clock time from restore invocation through post-restore verification.

A passing drill requires both objectives to be measured from terminal evidence. A successful Wrangler exit code alone is not sufficient.

## Recovery mechanism

PawSpace uses Cloudflare D1 native Time Travel for point-in-time recovery. The operator captures the current bookmark with:

```bash
npx wrangler d1 time-travel info pawspace-staging --json
```

Recovery is performed in place with the captured bookmark:

```bash
npx wrangler d1 time-travel restore pawspace-staging --bookmark=<bookmark> -y
```

The automated drill is `scripts/dr/d1-restore-drill.sh`. It creates or updates only a dedicated synthetic table named `dr_restore_drill_sentinel`, captures its exact pre-corruption state and a D1 bookmark, corrupts that sentinel, restores the database to the bookmark, and requires the restored row to match the pre-corruption row byte-for-byte after canonical JSON serialization.

## Safety controls

1. The drill script refuses every database name except `pawspace-staging`.
2. The script never accepts a production override flag.
3. Synthetic corruption is isolated to `dr_restore_drill_sentinel`; no customer, ledger, identity, `app_users`, or DPDP table is modified by the drill.
4. The script aborts if no bookmark is returned, if corruption is not observable, if restore fails, or if post-restore state differs from the captured baseline.
5. Evidence must include the bookmark, before/corrupted/after sentinel states, restore duration, total drill duration, and PASS/FAIL result.

## Drill cadence and incident use

Run the isolated UAT restore drill before a production freeze and after material D1 backup/restore tooling changes. For a real production incident, use the existing governed `scripts/d1-restore.mjs` production gates and never use this destructive UAT drill script against production.
