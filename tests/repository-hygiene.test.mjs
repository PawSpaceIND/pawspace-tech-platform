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
