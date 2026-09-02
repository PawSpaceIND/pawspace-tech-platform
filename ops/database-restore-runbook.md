# D1 database restore runbook

**Status: the recovery path in this document has never been executed.** Writing tooling is not the same
as having a tested restore, and this file does not close that gap. It closes when somebody runs
[the drill](#the-drill) against staging and records the result in [Drill log](#drill-log). Until a row
appears there, treat PawSpace as having an *untested* restore path.

Audience: whoever is on call. Assumes no prior context on D1.

---

## 1. What you have

Two recovery mechanisms. They fail in different ways, which is why both exist.

| | Time Travel | SQL dump |
|---|---|---|
| What it is | D1's own continuous history | A file produced by `scripts/d1-backup.mjs` |
| Recovery point | Any instant in the last **30 days** | The moment the last backup ran |
| Typical RPO | Seconds | The backup interval |
| Speed | ~1 minute | Minutes to hours, with size |
| Restores | **In place**, over the existing database | Into any database, including a new one |
| Survives the database being deleted | **No** | Yes |
| Survives losing the Cloudflare account | **No** | Yes |
| Survives an incident older than 30 days | **No** | Yes |

**Use Time Travel** for the common case: a bad migration, a bad bulk write, a deploy that corrupted data.
It is faster and loses less.

**Use the dump** when Time Travel cannot help: the database is gone, the account is gone, the damage is
older than 30 days, or you need the data somewhere else.

---

## 2. Before you touch anything

Write these down. You will need them for the incident record and you will not remember them later.

1. **Detection time** — when a human first knew something was wrong. RTO is measured from here, not from
   when you started typing.
2. **Last-known-good time** — the latest moment you believe the data was correct. This is your restore
   target. If you are not sure, pick *earlier*; over-restoring loses less than under-restoring.
3. **Who is deciding.** A production restore is a decision with a name attached.

Then check credentials are present in your shell:

```bash
[ -n "$CLOUDFLARE_API_TOKEN" ] && [ -n "$CLOUDFLARE_ACCOUNT_ID" ] && echo ok || echo "not authenticated"
```

Both scripts refuse with a clear message rather than a stack trace if these are missing. They are never
read from a file in the repository.

---

## 3. Restore: Time Travel (the usual path)

### 3.1 See what is available

```bash
npx wrangler d1 time-travel info pawspace-staging
npx wrangler d1 time-travel info pawspace-staging --timestamp 2026-09-02T05:00:00Z
```

### 3.2 Plan it

Every restore is a plan first. Without `--execute` nothing happens.

```bash
node scripts/d1-restore.mjs --environment staging --timestamp 2026-09-02T05:00:00Z
```

Read the plan. Confirm the target is the database you meant.

### 3.3 Execute

```bash
node scripts/d1-restore.mjs --environment staging --timestamp 2026-09-02T05:00:00Z --execute
```

The script prints a **PRE-RESTORE BOOKMARK** before it overwrites anything, with the exact command to
undo. **Copy that line somewhere outside your terminal.** If the restore turns out to be to the wrong
point, that bookmark is how you get back to the state you had a minute ago. The script refuses to
proceed if it cannot capture one.

### 3.4 Production

Production needs two independent gates, deliberately:

```bash
export PAWSPACE_RESTORE_ALLOW_PRODUCTION=yes
node scripts/d1-restore.mjs --environment production \
  --timestamp 2026-09-02T05:00:00Z \
  --confirm-production pawspace-prod-bengaluru \
  --execute
```

Either gate alone is refused. Neither is a formality: a restore overwrites live customer data, which is
worse than a bad deploy, and a deploy already requires a typed confirmation in this repository.

---

## 4. Restore: from a dump

```bash
# Take one (also run on a schedule — see §6)
node scripts/d1-backup.mjs --environment staging

# Restore it
node scripts/d1-restore.mjs --environment staging --file backups/pawspace-staging-<stamp>.sql --execute
```

If a `.manifest.json` sits beside the dump, its SHA-256 is verified before anything is restored. A
truncated file restored over a live database is a second incident on top of the first.

---

## 5. Measuring RPO and RTO

Both are **measurements taken during a real restore or a drill**. Neither is a number this repository
asserts about itself.

**RPO — how much work the restore discarded.**

```
RPO = (time of the last good write that was lost) − (the recovery point you restored to)
```

In practice: `incident time − recovery point`. `scripts/d1-restore.mjs` computes this automatically when
it can infer the recovery point (a `--timestamp`, or a manifest's `recoveryPointAt`) and writes it to
`ops/evidence/restore-<stamp>.json` as `rpoSeconds`. **When it cannot infer one it records `null`, not
zero** — an unknown RPO must never read as "no data lost".

For a `--bookmark` restore the tooling cannot know what instant the bookmark represents, so `rpoSeconds`
is `null` and you record it by hand from `time-travel info`.

**RTO — how long service was broken.**

```
RTO = (service confirmed working) − (detection time from §2)
```

The `restoreSeconds` in the evidence file is **only the restore command**. It is a lower bound and always
smaller than the real RTO, which includes deciding what to restore to, getting approval for production,
and verifying afterwards. Record the real number in the drill log; do not quote `restoreSeconds` as RTO.

Targets to measure against: **RPO < 15 minutes, RTO < 30 minutes.** These are the pilot's stated goals.
They are not evidence until a drill produces numbers under them.

---

## 6. Backup schedule

Not yet automated. The dump path's RPO is exactly the interval at which someone runs:

```bash
node scripts/d1-backup.mjs --environment production --output-dir <durable storage>
```

`backups/` is git-ignored — a database dump must never enter the repository. Until this runs on a
schedule into storage outside Cloudflare, **the dump path's RPO is "whenever somebody last remembered",
and only Time Travel's 30-day window is actually protecting you.** That is a real gap; it is written
down here rather than left implicit.

---

## <a id="the-drill"></a>7. The drill

Run this **before** relying on any of the above, and quarterly after. Two parts, because the two paths
fail differently and a drill of one proves nothing about the other.

### 7a. Dump path — non-destructive, safe any time

Restores a real backup into a brand-new scratch database. Touches nothing live.

```bash
node scripts/d1-backup.mjs --environment staging
node scripts/d1-restore.mjs --file backups/pawspace-staging-<stamp>.sql \
  --into-scratch drill-$(date +%Y%m%d) --execute
npx wrangler d1 delete drill-$(date +%Y%m%d)     # clean up
```

The script verifies the restored database actually contains tables and **exits non-zero if it cannot
show that**. A restore command exiting 0 is not evidence that data arrived.

### 7b. Time Travel path — destructive, staging only

```bash
node scripts/d1-restore.mjs --environment staging --timestamp <15 minutes ago> --execute
```

The tooling refuses this against production, because Time Travel restores in place and a "drill" there
would be an outage.

### What to record

Time the whole thing from decision to verified, not just the command.

---

## <a id="drill-log"></a>8. Drill log

| Date | Who | Path | Measured RTO | Measured RPO | Result |
|---|---|---|---|---|---|
| _(none yet)_ | | | | | **The restore path is unproven until a row appears here.** |

---

## 9. What this tooling does not do

Stated so nobody assumes otherwise:

- **No automated backup schedule.** §6.
- **No off-Cloudflare replication.** Dumps go wherever the operator points `--output-dir`. If that is a
  laptop, that is your disaster recovery.
- **No R2 media restore.** This covers D1 only. Uploaded photos and documents live in R2 and have no
  restore path documented here.
- **No application-level consistency check.** The drill proves tables exist and the SQL loaded. It does
  not prove the ledger reconciles after a restore. A restore to a point mid-transaction can leave
  application state that is internally valid SQL and wrong for the business.
- **It has never been run.** See the top of this file.
