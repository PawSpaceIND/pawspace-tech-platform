#!/usr/bin/env node
/**
 * Restore a D1 database, and measure how long it took.
 *
 *   Fast, in place, from D1's own history:
 *     node scripts/d1-restore.mjs --environment staging --timestamp 2026-09-02T05:00:00Z
 *     node scripts/d1-restore.mjs --environment staging --bookmark <bookmark>
 *
 *   Portable, from a dump taken by scripts/d1-backup.mjs:
 *     node scripts/d1-restore.mjs --environment staging --file backups/pawspace-staging-….sql
 *
 *   Non-destructive drill - restore a dump into a scratch database and verify it, touching nothing real:
 *     node scripts/d1-restore.mjs --file backups/….sql --into-scratch drill-2026-09-02
 *
 * Production requires TWO independent gates (see assertRestoreAllowed) and is never the default.
 *
 * WHAT THIS DOES BEFORE IT OVERWRITES ANYTHING. It captures the CURRENT bookmark of the target and
 * prints it, then refuses to continue if that capture failed. A restore is the one operation people
 * reach for while already under pressure, and the way it turns a bad hour into a bad quarter is
 * restoring the wrong point and having no way back to the state you had five minutes ago. That
 * bookmark is the way back, and it is worth failing the restore to have it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  resolveEnvironment, requireCredentials, resolveRestoreSource, assertRestoreAllowed, computeRpoSeconds, RefusedError,
} from "./d1-environments.mjs";

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) return process.argv[index + 1];
  const inline = process.argv.find((item) => item.startsWith(`--${name}=`));
  return inline ? inline.slice(`--${name}=`.length) : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

function wrangler(args, { capture = true } = {}) {
  return execFileSync("npx", ["wrangler", ...args], {
    encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", maxBuffer: 64 * 1024 * 1024,
  });
}

try {
  requireCredentials();
  const source = resolveRestoreSource({ bookmark: arg("bookmark"), timestamp: arg("timestamp"), file: arg("file") });
  const scratch = arg("into-scratch");

  /* A scratch drill has no environment: it creates its own throwaway database, so there is nothing
   * real to name and nothing real to overwrite. Requiring --environment here would mean typing the
   * name of a live database in order to run an exercise that must not touch one. */
  let environment = null;
  if (!scratch) {
    environment = resolveEnvironment(arg("environment"));
    assertRestoreAllowed({ environment, confirmProduction: arg("confirm-production") });
  } else if (source.kind !== "file") {
    throw new RefusedError(`--into-scratch restores a dump into a new database, so it needs --file. ` +
      `Time Travel restores a database in place and cannot target a different one.`);
  }

  const target = scratch || environment.database;
  const drill = Boolean(scratch);

  if (source.kind === "file") {
    if (!existsSync(source.value)) throw new RefusedError(`Backup file not found: ${source.value}`);
    if (!statSync(source.value).size) throw new RefusedError(`Backup file is empty: ${source.value}`);
    /* If a manifest sits beside the dump, the checksum is verified before the dump is trusted. A
     * truncated download restored over a live database is a second incident on top of the first. */
    const manifestPath = `${source.value}.manifest.json`;
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const actual = createHash("sha256").update(readFileSync(source.value)).digest("hex");
      if (manifest.sha256 && manifest.sha256 !== actual) {
        throw new RefusedError(`Checksum mismatch for ${source.value}.\n  manifest ${manifest.sha256}\n  actual   ${actual}\n` +
          `This file is not the backup that was taken. Refusing to restore it.`);
      }
      console.log(`Backup checksum verified against its manifest.`);
    } else {
      console.warn(`No manifest beside ${source.value} - its integrity cannot be verified. Continuing.`);
    }
  }

  console.log(`\nPlan`);
  console.log(`  target      ${target}${drill ? " (scratch database, created for this drill)" : environment.production ? "  *** PRODUCTION ***" : ""}`);
  console.log(`  source      --${source.kind} ${source.value}`);
  if (!flag("execute")) {
    console.log(`\nThis was a plan only. Re-run with --execute to perform it.\n`);
    process.exit(0);
  }

  /* The way back. Captured for real targets only - a scratch database has no prior state worth keeping. */
  let priorBookmark = null;
  if (!drill) {
    try {
      priorBookmark = JSON.parse(wrangler(["d1", "time-travel", "info", target, "--json"]))?.bookmark ?? null;
    } catch (error) {
      throw new Error(`Could not capture the current bookmark for ${target}, so this restore would have no undo. ` +
        `Refusing to continue. (${String(error?.stderr || error?.message || error).slice(0, 300)})`);
    }
    if (!priorBookmark) throw new Error(`No current bookmark returned for ${target}; refusing a restore with no way back.`);
    console.log(`\nPRE-RESTORE BOOKMARK (this is your undo): ${priorBookmark}`);
    console.log(`  Undo with: node scripts/d1-restore.mjs --environment ${environment.key} --bookmark ${priorBookmark} --execute` +
      `${environment.production ? ` --confirm-production ${environment.database}` : ""}`);
  }

  const startedAt = Date.now();
  if (drill) {
    console.log(`\nCreating scratch database ${target} …`);
    wrangler(["d1", "create", target], { capture: false });
  }
  if (source.kind === "file") {
    console.log(`\nRestoring ${source.value} into ${target} …`);
    wrangler(["d1", "execute", target, "--remote", "--file", source.value, "-y"], { capture: false });
  } else {
    console.log(`\nTime-travelling ${target} to the requested point …`);
    wrangler(["d1", "time-travel", "restore", target, `--${source.kind}`, source.value, "-y"], { capture: false });
  }
  const finishedAt = Date.now();

  /* Verification. A restore that reports success and leaves an empty database has not restored
   * anything, and "the command exited 0" is not evidence that it worked. */
  let tables = null;
  try {
    const probe = wrangler(["d1", "execute", target, "--remote", "--json", "--command",
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'"]);
    tables = JSON.parse(probe)?.[0]?.results?.[0]?.n ?? null;
  } catch { /* reported as unverified below */ }

  const recoveryPointAt = source.kind === "file" && existsSync(`${source.value}.manifest.json`)
    ? Date.parse(JSON.parse(readFileSync(`${source.value}.manifest.json`, "utf8")).recoveryPointAt)
    : source.kind === "timestamp" ? Date.parse(source.value) : null;

  const evidence = {
    target, drill, source: { kind: source.kind, value: source.kind === "bookmark" ? "(bookmark)" : source.value },
    priorBookmark,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    /* RTO measured here is the RESTORE COMMAND only. The runbook's RTO is wall-clock from detection to
     * service restored, which is always larger - it includes a human deciding what to restore to. */
    restoreSeconds: Math.round((finishedAt - startedAt) / 1000),
    rpoSeconds: computeRpoSeconds({ incidentAt: startedAt, recoveryPointAt }),
    tablesAfterRestore: tables,
    verified: typeof tables === "number" && tables > 0,
  };
  mkdirSync("ops/evidence", { recursive: true });
  const evidencePath = path.join("ops/evidence", `restore-${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

  console.log(`\nRestore finished in ${evidence.restoreSeconds}s.`);
  console.log(`  tables after restore   ${tables ?? "UNVERIFIED"}`);
  if (evidence.rpoSeconds !== null) console.log(`  recovery point age     ${evidence.rpoSeconds}s before the restore started`);
  console.log(`  evidence               ${evidencePath}`);
  if (!evidence.verified) {
    console.error(`\nThe restore command succeeded but the database could not be shown to contain tables.`);
    console.error(`Do NOT record this as a passing drill. Investigate before trusting this path.`);
    process.exit(1);
  }
  if (drill) console.log(`\nScratch database ${target} still exists. Delete it: npx wrangler d1 delete ${target}`);
} catch (error) {
  if (error instanceof RefusedError) { console.error(`\n${error.message}\n`); process.exit(2); }
  console.error(`\nRestore failed: ${error?.message || error}\n`);
  process.exit(1);
}
