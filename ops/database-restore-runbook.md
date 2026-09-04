# D1 database restore runbook

**Status: scratch restore path tested successfully on 2026-09-03.** The staging SQL-dump path was exercised end to end in GitHub Actions run `33784605827`: a real `pawspace-staging` export was checksum-manifested, restored into a newly created scratch D1 database, verified to contain **628 tables**, recorded **26 seconds** for the restore command and **14 seconds** recovery-point age, uploaded evidence artifact `9904947758`, and then deleted the scratch database successfully.

This proves the portable SQL-dump recovery path. It does **not** authorize or prove a production restore, and it does not replace a future staging Time Travel drill or application-level reconciliation check.

## 1. Recovery mechanisms

| | Time Travel | SQL dump |
|---|---|---|
| Recovery point | Any instant in D1's retained history | Time the backup was taken |
| Restore shape | In place | Any database, including scratch |
| Survives DB deletion | No | Yes |
| Safe drill target | Staging only | Scratch database |

Use Time Travel for ordinary bad-write/bad-migration recovery. Use a SQL dump when you need a portable restore or a scratch drill.

## 2. Safety rules

Credentials must come from the process environment only:

```bash
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

The tooling uses exact environment names. `prod` does not mean `production`, and there is no default.

Every restore is plan-only unless `--execute` is present. Production additionally requires **both**:

```bash
export PAWSPACE_RESTORE_ALLOW_PRODUCTION=yes
--confirm-production pawspace-prod-bengaluru
```

A production restore is never part of a drill. It overwrites live customer data and remains subject to the separate PawSpace production release/incident authorization process.

## 3. Backup

```bash
node scripts/d1-backup.mjs --environment staging --output-dir backups
```

The backup script captures a Time Travel bookmark before export, writes a SHA-256 manifest, and fails if the exported SQL file is empty. `backups/` and manifest files are git-ignored because they can contain customer data.

## 4. Restore from a dump

Plan:

```bash
node scripts/d1-restore.mjs --environment staging --file backups/pawspace-staging-<stamp>.sql
```

Execute:

```bash
node scripts/d1-restore.mjs --environment staging --file backups/pawspace-staging-<stamp>.sql --execute
```

When a manifest is present its checksum is verified before restore. Real-target restores capture the current bookmark first and refuse to continue if no undo bookmark can be obtained.

## 5. Scratch drill — preferred non-destructive proof

```bash
node scripts/d1-backup.mjs --environment staging --output-dir backups
node scripts/d1-restore.mjs \
  --file backups/pawspace-staging-<stamp>.sql \
  --into-scratch drill-$(date +%Y%m%d) \
  --execute
npx wrangler d1 delete drill-$(date +%Y%m%d) -y
```

The restore verifies that tables exist and writes `ops/evidence/restore-<stamp>.json`. A zero exit code from Wrangler alone is not accepted as recovery evidence.

The repository also contains `.github/workflows/d1-restore-scratch-drill.yml`, scoped to the Track 5 branch, which performs this sequence with the `pawspace-staging` GitHub environment and always attempts scratch cleanup.

## 6. Time Travel restore

Plan:

```bash
node scripts/d1-restore.mjs --environment staging --timestamp 2026-09-02T05:00:00Z
```

Execute on staging only when intentionally testing the destructive Time Travel path:

```bash
node scripts/d1-restore.mjs --environment staging --timestamp 2026-09-02T05:00:00Z --execute
```

Do not run a Time Travel drill against production.

## 7. RPO and RTO

`rpoSeconds` is measured from the recovery point when that point has a timestamp. Unknown RPO is recorded as `null`, never zero.

`restoreSeconds` measures only the restore command. Incident RTO is broader: detection/decision through verified service recovery. For automated scratch drills, retain both the workflow timing and `restoreSeconds`; do not mislabel the command duration as a production incident RTO.

Pilot goals remain:
- RPO < 15 minutes
- RTO < 30 minutes

The 2026-09-03 scratch drill was comfortably inside those thresholds for the dump/recovery command path, but it is not production incident evidence.

## 8. Drill log

| Date | Executor | Path | Evidence | Restore command | Recovery-point age | Result |
|---|---|---|---|---:|---:|---|
| 2026-09-03 | GitHub Actions / PawSpace | staging dump → new scratch D1 | run `33784605827`, artifact `9904947758`, SHA-256 `92dee205f45f7bd8e36da220842df7693d409207c1f4558aaeb6ff4a1d36c99d` | 26 s | 14 s | **PASS — 628 tables verified; scratch DB deleted** |

## 9. Remaining recovery work

The successful scratch drill closes the build-review finding that the D1 restore tooling had never been exercised. These broader resilience items remain separate follow-ups and are not falsely claimed as closed by this drill:

- automate a durable production backup schedule outside Cloudflare;
- maintain off-Cloudflare backup replication;
- document and test R2 media recovery;
- add application-level post-restore consistency checks (ledger/reconciliation, not only table existence);
- periodically exercise the staging Time Travel path.

No production deployment or production restore is authorized by this runbook or by the 2026-09-03 drill.
