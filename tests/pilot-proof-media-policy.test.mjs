/**
 * Pilot proof-media policy (Bengaluru UAT sign-off, 2026-09-13): partner before/after proof is
 * metadata-only until a byte-upload path exists. Binding a media bucket in production would make
 * every confirm_upload fail with stored_object_missing (the stored object becomes authoritative and
 * nothing uploads it), so a groomer could never complete a job. The production config must refuse a
 * bucket unless the upload path is explicitly declared ready.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

function runProdConfig(env) {
  const dir = mkdtempSync(path.join(tmpdir(), "prod-config-"));
  mkdirSync(path.join(dir, "dist", "server"), { recursive: true });
  writeFileSync(path.join(dir, "dist", "server", "wrangler.json"), JSON.stringify({ name: "pawspace-tech-platform", main: "index.js", vars: {} }));
  const script = new URL("../scripts/prod-config.mjs", import.meta.url).pathname;
  try {
    const stdout = execFileSync(process.execPath, [script], { cwd: dir, env: { PATH: process.env.PATH, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return { status: Number(error.status), stdout: String(error.stdout || ""), stderr: String(error.stderr || "") };
  }
}

const GUARD = /PRODUCTION_R2_BUCKET_NAME is set but no byte-upload path exists/;

test("production config refuses a media bucket while proof is metadata-only", () => {
  const withBucket = runProdConfig({ PRODUCTION_R2_BUCKET_NAME: "pawspace-prod-media" });
  assert.notEqual(withBucket.status, 0);
  assert.match(withBucket.stderr, GUARD, "a bucket without a byte-upload path must be refused with the pilot policy named");
});

test("production config allows the bucket only once the upload path is declared ready", () => {
  const declared = runProdConfig({ PRODUCTION_R2_BUCKET_NAME: "pawspace-prod-media", PRODUCTION_MEDIA_OBJECT_UPLOAD_READY: "true" });
  assert.doesNotMatch(declared.stderr, GUARD, "an explicit declaration lifts this refusal (other production requirements still apply)");
  const unset = runProdConfig({});
  assert.doesNotMatch(unset.stderr, GUARD, "no bucket, no refusal: metadata-only is the pilot default");
});

test("the production workflow passes the declaration through as a repository variable", () => {
  const workflow = read(".github/workflows/deploy-production.yml");
  const passes = workflow.match(/PRODUCTION_MEDIA_OBJECT_UPLOAD_READY: \$\{\{ vars\.PRODUCTION_MEDIA_OBJECT_UPLOAD_READY \}\}/g) || [];
  const buckets = workflow.match(/PRODUCTION_R2_BUCKET_NAME: \$\{\{ vars\.PRODUCTION_R2_BUCKET_NAME \}\}/g) || [];
  assert.equal(passes.length, buckets.length, "everywhere the bucket name is passed, the declaration is passed beside it");
  assert.ok(passes.length >= 1);
});

test("the Booking Command Center list is newest-first with server-side search wired from the page", () => {
  const route = read("app/api/booking-command-center/route.ts");
  assert.match(route, /ORDER BY \$\{order\} LIMIT \$\{limit\}/);
  assert.match(route, /"b\.created_at DESC, b\.scheduled_start DESC"/, "default order is newest-created first");
  assert.match(route, /options\.sort==="schedule"\?"b\.scheduled_start DESC"/, "the old order stays available");
  assert.match(route, /BOOKING_LIST_MAX_LIMIT=500/);
  const page = read("app/booking-command-center/page.tsx");
  assert.match(page, /\/api\/booking-command-center\?q=\$\{encodeURIComponent\(serverQuery\)\}/, "the search box asks the server once it has three characters");
});
