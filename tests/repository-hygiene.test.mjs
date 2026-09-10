import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Repository hygiene, enforced rather than tidied once.
//
// backend/node_modules was tracked: 3,616 files, 76 MB of installed packages. It had no purpose — the
// Backend CI job runs `npm ci` in that directory, which deletes and reinstalls the tree on every run, so
// the committed copy was overwritten before anything used it. It survived because .gitignore listed
// "/node_modules", which is anchored to the repository root and never matched a nested one.
//
// A one-off `git rm --cached` would fix today and nothing else. These tests fail the build if a
// dependency tree, a build output, a local database, a runner artefact or an obvious secret file is
// committed again.
// ---------------------------------------------------------------------------

const tracked = (() => {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: new URL("..", import.meta.url), maxBuffer: 64 * 1024 * 1024 });
  return out.toString("utf8").split("\0").filter(Boolean);
})();

test("the repository tracks a plausible number of files at all", () => {
  // Guards the guard: if `git ls-files` ever returned nothing, every assertion below would pass vacuously.
  assert.ok(tracked.length > 200, `expected a populated repository, saw ${tracked.length} tracked files`);
});

// --- dependency trees and build output ---------------------------------------------------------------

test("no dependency tree is committed, at any depth", () => {
  const offenders = tracked.filter((file) => file.split("/").includes("node_modules"));
  assert.deepEqual(offenders.slice(0, 10), [],
    `${offenders.length} files under a node_modules directory are tracked; CI reinstalls these with npm ci`);
});

test("no build output is committed", () => {
  // .vinext/fonts is deliberately tracked — those webfonts are inputs the build copies, not output it
  // produces — so the check is scoped to the directories that genuinely hold generated artefacts.
  const generated = [/^dist\//, /^\.next\//, /^backend\/dist\//, /^out\//, /^coverage\//];
  const offenders = tracked.filter((file) => generated.some((pattern) => pattern.test(file)));
  assert.deepEqual(offenders.slice(0, 10), [], `${offenders.length} generated build files are tracked`);
});

test("no local database or wrangler persistence is committed", () => {
  const offenders = tracked.filter((file) =>
    /(^|\/)\.(runtime|pricing-control|scheduler|production-readiness)-d1\//.test(file) ||
    /(^|\/)\.wrangler\//.test(file) ||
    /\.sqlite3?$/.test(file) || /\.db$/.test(file));
  assert.deepEqual(offenders.slice(0, 10), [], `${offenders.length} local database/persistence files are tracked`);
});

test("no runner or editor artefact is committed", () => {
  const offenders = tracked.filter((file) =>
    /(^|\/)\.DS_Store$/.test(file) || /(^|\/)Thumbs\.db$/.test(file) ||
    /(^|\/)\.idea\//.test(file) || /(^|\/)npm-debug\.log/.test(file) ||
    /\.tsbuildinfo$/.test(file) || /(^|\/)\.turbo\//.test(file));
  assert.deepEqual(offenders.slice(0, 10), []);
});

test("no log file is committed", () => {
  const offenders = tracked.filter((file) => /\.log$/.test(file));
  assert.deepEqual(offenders.slice(0, 10), []);
});

// --- obvious secret artefacts -------------------------------------------------------------------------

test("no obvious secret artefact is committed", () => {
  // Filenames only. This is a coarse net for the accidents that actually happen — a dotenv file, a
  // private key, a service-account json — not a substitute for secret scanning.
  const offenders = tracked.filter((file) => {
    const name = file.split("/").pop() ?? "";
    if (/^\.env($|\.)/.test(name) && !/\.example$|\.sample$|\.template$/.test(name)) return true;
    if (/\.(pem|key|p12|pfx|keystore|jks)$/.test(name)) return true;
    if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(name)) return true;
    if (/(^|[-_.])service-account.*\.json$/.test(name)) return true;
    return false;
  });
  assert.deepEqual(offenders.slice(0, 10), [], `${offenders.length} files look like committed credentials`);
});

// --- the ignore rules that keep it that way -----------------------------------------------------------

test(".gitignore excludes nested dependency trees, not only the root one", async () => {
  const fs = await import("node:fs");
  const rules = fs.readFileSync(new URL("../.gitignore", import.meta.url), "utf8")
    .split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  assert.ok(rules.includes("node_modules/") || rules.includes("**/node_modules/"),
    "an unanchored node_modules rule is what stops backend/node_modules being re-added; '/node_modules' alone does not");
});

test("a clean clone can still install the backend, because its manifest and lockfile are tracked", () => {
  // Removing the committed tree is only safe if the inputs to reinstall it remain.
  assert.ok(tracked.includes("backend/package.json"), "backend/package.json must stay tracked");
  assert.ok(tracked.includes("backend/package-lock.json"), "backend/package-lock.json must stay tracked");
  assert.ok(tracked.includes("package.json") && tracked.includes("package-lock.json"),
    "the root manifest and lockfile must stay tracked");
});


test("branch hygiene keeps deletion manual-only and exact-tip leased", async () => {
  const fs = await import("node:fs");
  const workflow = fs.readFileSync(new URL("../.github/workflows/branch-hygiene.yml", import.meta.url), "utf8");
  const script = fs.readFileSync(new URL("../scripts/maintenance/prune-merged-remote-branches.sh", import.meta.url), "utf8");
  const automatic = workflow.slice(workflow.indexOf("  delete-after-merge:"), workflow.indexOf("  explicit-delete:"));
  const manual = workflow.slice(workflow.indexOf("  explicit-delete:"));
  assert.match(automatic, /--dry-run/);
  assert.doesNotMatch(automatic, /--execute/);
  assert.match(manual, /DELETE_MERGED_BRANCHES/);
  assert.match(manual, /--execute/);
  assert.match(script, /\[ "\$1" = "\$BASE" \] && return 0/);
  assert.match(script, /--force-with-lease="refs\/heads\/\$branch:\$tip"/);
  assert.match(script, /skip newly active PR head/);
});

test("an exact-tip deletion lease refuses a branch that moved after discovery", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pawspace-branch-lease-"));
  const bare = path.join(root, "remote.git"), work = path.join(root, "work");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--bare", bare], { stdio: "ignore" });
  execFileSync("git", ["clone", bare, work], { stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "hygiene@test.invalid"], { cwd: work });
  execFileSync("git", ["config", "user.name", "Hygiene Test"], { cwd: work });
  fs.writeFileSync(path.join(work, "base.txt"), "base\n");
  execFileSync("git", ["checkout", "-b", "main"], { cwd: work, stdio: "ignore" });
  execFileSync("git", ["add", "base.txt"], { cwd: work });
  execFileSync("git", ["commit", "-m", "base"], { cwd: work, stdio: "ignore" });
  const discovered = execFileSync("git", ["rev-parse", "HEAD"], { cwd: work, encoding: "utf8" }).trim();
  execFileSync("git", ["branch", "feature"], { cwd: work });
  execFileSync("git", ["push", "origin", "main", "feature"], { cwd: work, stdio: "ignore" });
  fs.writeFileSync(path.join(work, "main.txt"), "merged base advanced\n");
  execFileSync("git", ["add", "main.txt"], { cwd: work });
  execFileSync("git", ["commit", "-m", "advance main"], { cwd: work, stdio: "ignore" });
  execFileSync("git", ["push", "origin", "main"], { cwd: work, stdio: "ignore" });
  execFileSync("git", ["checkout", "feature"], { cwd: work, stdio: "ignore" });
  fs.writeFileSync(path.join(work, "new-work.txt"), "new unmerged work\n");
  execFileSync("git", ["add", "new-work.txt"], { cwd: work });
  execFileSync("git", ["commit", "-m", "new feature work"], { cwd: work, stdio: "ignore" });
  const moved = execFileSync("git", ["rev-parse", "HEAD"], { cwd: work, encoding: "utf8" }).trim();
  execFileSync("git", ["push", "--force", "origin", "feature"], { cwd: work, stdio: "ignore" });
  assert.throws(() => execFileSync("git", ["push", `--force-with-lease=refs/heads/feature:${discovered}`, "origin", ":refs/heads/feature"], { cwd: work, stdio: "pipe" }));
  const remote = execFileSync("git", ["ls-remote", "--heads", "origin", "refs/heads/feature"], { cwd: work, encoding: "utf8" });
  assert.match(remote, new RegExp(`^${moved}\\s+refs/heads/feature`));
});
