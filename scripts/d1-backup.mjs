#!/usr/bin/env node
/**
 * Take a portable backup of a D1 database, and record the Time Travel bookmark that was current when
 * it was taken.
 *
 *   node scripts/d1-backup.mjs --environment staging [--output-dir backups]
 *
 * Requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment. Nothing is read from a
 * repository file, and no credential or database identifier is written to the manifest.
 *
 * WHY BOTH A DUMP AND A BOOKMARK. D1 gives two recovery mechanisms and they fail in different ways,
 * so a backup that records only one leaves a hole:
 *
 *   Time Travel  is continuous, restores in about a minute, and its recovery point is effectively the
 *                instant you name - but it lives inside D1. It cannot help if the database is deleted,
 *                if the account is lost, or once the incident is older than the 30-day window.
 *   The SQL dump is portable and survives all three of those, but its recovery point is only as fresh
 *                as the last run of this script, and restoring a large one is materially slower.
 *
 * The bookmark is captured BEFORE the export starts. An export takes time, and a bookmark taken after
 * it finishes would name a database state later than the file - so restoring "to the bookmark in the
 * manifest" would not reproduce the file. Taken first, the bookmark is at worst slightly older than the
 * dump, which is the safe direction to be wrong in.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, statSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { resolveEnvironment, requireCredentials, RefusedError } from "./d1-environments.mjs";

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) return process.argv[index + 1];
  const inline = process.argv.find((item) => item.startsWith(`--${name}=`));
  return inline ? inline.slice(`--${name}=`.length) : fallback;
}

function wrangler(args, { capture = true } = {}) {
  return execFileSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    maxBuffer: 64 * 1024 * 1024,
  });
}

try {
  const environment = resolveEnvironment(arg("environment"));
  requireCredentials();

  const startedAt = Date.now();
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
  const outputDir = path.resolve(arg("output-dir", "backups"));
  mkdirSync(outputDir, { recursive: true });
  const sqlPath = path.join(outputDir, `${environment.database}-${stamp}.sql`);

  /* Captured first - see the header. A backup whose bookmark is newer than its dump is worse than no
   * bookmark, because it looks usable. */
  let bookmark = null, bookmarkError = null;
  try {
    const info = wrangler(["d1", "time-travel", "info", environment.database, "--json"]);
    bookmark = JSON.parse(info)?.bookmark ?? null;
  } catch (error) {
    bookmarkError = String(error?.stderr || error?.message || error).slice(0, 500);
  }

  console.log(`Exporting ${environment.database} …`);
  wrangler(["d1", "export", environment.database, "--remote", "--output", sqlPath, "-y"], { capture: false });

  const bytes = statSync(sqlPath).size;
  if (!bytes) throw new Error(`Export produced an empty file at ${sqlPath} - refusing to record it as a backup.`);
  /* A backup nobody can prove is intact is a backup nobody should trust. The runbook's verify step
   * re-computes this before any restore. */
  const sha256 = createHash("sha256").update(readFileSync(sqlPath)).digest("hex");
  const finishedAt = Date.now();

  const manifest = {
    environment: environment.key,
    database: environment.database,
    file: path.basename(sqlPath),
    bytes,
    sha256,
    /* The recovery point this backup actually offers. RPO at restore time is (incident - this). */
    recoveryPointAt: new Date(startedAt).toISOString(),
    bookmark,
    bookmarkError,
    exportSeconds: Math.round((finishedAt - startedAt) / 1000),
    takenBy: process.env.GITHUB_ACTOR || process.env.USER || "unknown",
    wrangler: wrangler(["--version"]).trim().split("\n").pop(),
  };
  const manifestPath = `${sqlPath}.manifest.json`;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`\nBackup complete.`);
  console.log(`  file      ${sqlPath}`);
  console.log(`  size      ${(bytes / 1024 / 1024).toFixed(2)} MiB`);
  console.log(`  sha256    ${sha256}`);
  console.log(`  bookmark  ${bookmark ?? `UNAVAILABLE (${bookmarkError ? "see manifest" : "no bookmark returned"})`}`);
  console.log(`  manifest  ${manifestPath}`);
  if (!bookmark) {
    console.warn(`\nWARNING: no Time Travel bookmark was recorded, so the fast in-place restore path has no`);
    console.warn(`recorded point for this backup. The dump is still restorable. Investigate before relying on this.`);
  }
  console.log(`\nDatabase identifiers are not logged. Credentials are read from the environment and never written.`);
} catch (error) {
  if (error instanceof RefusedError) { console.error(`\n${error.message}\n`); process.exit(2); }
  console.error(`\nBackup failed: ${error?.message || error}\n`);
  process.exit(1);
}
