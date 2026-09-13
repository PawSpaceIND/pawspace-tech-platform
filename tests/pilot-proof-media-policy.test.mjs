/**
 * Pilot proof-media policy (Bengaluru UAT sign-off, 2026-09-13): partner before/after proof is
 * METADATA-ONLY until a byte-upload path exists, and production release rests on the explicitly set
 * manual-review policy, not on a reviewer's say-so. Each case below runs the real boundary:
 *
 *   1. No bucket binding: the adapter is not connected, confirm_upload takes the Partner app's observed
 *      checksum/size/type, and a second person's approval releases the asset ONLY once the
 *      media_scan_policy manual-review permission is set (production stays blocked without it).
 *   2. A bucket binding with nothing uploaded: confirm_upload refuses with stored_object_missing - the
 *      failure the production-config guard exists to prevent.
 *   3. scripts/prod-config.mjs refuses PRODUCTION_R2_BUCKET_NAME unless the byte-upload path is declared
 *      ready, and the production workflow passes that declaration beside the bucket name.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PILOT_MEDIA_DB__", "__PILOT_MEDIA_ENV__");

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const SHA = "b".repeat(64);
const UPLOADER = "asha.groomer1@tkpetcare.in";
const REVIEWER = "founder@pawspace.in";

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  let depth = 0;
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      const outer = depth === 0;
      if (outer) sqlite.exec("BEGIN IMMEDIATE");
      depth += 1;
      try { const out = []; for (const item of items) out.push(await item.run()); if (outer) sqlite.exec("COMMIT"); return out; }
      catch (error) { if (outer) sqlite.exec("ROLLBACK"); throw error; }
      finally { depth -= 1; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

/** A stand-in for an R2 binding that holds no objects: the shape production would have with a bucket bound but no byte upload. */
const emptyBucket = () => ({ head: async () => null, get: async () => null });

async function world(env = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PILOT_MEDIA_DB__ = db;
  globalThis.__PILOT_MEDIA_ENV__ = env;
  const boundary = await import("../lib/media-upload-boundary.ts");
  await boundary.ensureMediaBoundaryTables(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT,schedule_group_id TEXT,provider_id TEXT,provider_name TEXT,provider_model TEXT,service_code TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.prepare("INSERT INTO provider_work_orders VALUES ('WO-PILOT','BK-PILOT','SG-PILOT','PRV-PILOT','PawSpace Grooming Team (UAT)','full_time','grooming','2026-09-17T03:30:00.000Z','2026-09-17T05:30:00.000Z','in_service',?,?)").run(Date.now(), Date.now());
  const register = () => boundary.issueMediaUploadGrant(db, {
    bookingId: "BK-PILOT", scopeType: "booking", scopeId: "BK-PILOT", providerId: "PRV-PILOT", serviceCode: "grooming", cityId: "blr",
    category: "after_service", mimeType: "image/jpeg", sizeBytes: 4096, sha256: SHA, fileName: "after.jpg", actorId: UPLOADER,
  });
  const confirm = (issued) => boundary.redeemMediaUploadGrant(db, { token: issued.token, objectKey: issued.objectKey, observed: { sizeBytes: 4096, sha256: SHA, mimeType: "image/jpeg" }, actorId: UPLOADER });
  const approve = (issued) => boundary.reviewMedia(db, { mediaId: issued.mediaId, decision: "approved", actorId: REVIEWER, reason: "Before and after photos show the booked pet" });
  return { sqlite, db, boundary, register, confirm, approve };
}

const refusal = (promise) => promise.then(() => null, async (error) => error instanceof Response ? { status: error.status, body: await error.clone().text() } : { status: 0, body: String(error?.message ?? error) });

test("metadata-only proof: without a bucket the adapter is not connected and the Partner app's observation is what gets verified", async () => {
  const { register, confirm } = await world({ PAWSPACE_MEDIA_ENV: "production" });
  const storage = await import("../lib/media-storage-adapter.ts");
  const status = await storage.mediaStorageStatus();
  assert.equal(status.connected, false, JSON.stringify(status));
  const issued = await register();
  const confirmed = await confirm(issued);
  assert.equal(confirmed.mediaId, issued.mediaId);
  assert.equal(confirmed.accessStatus, "quarantined", "confirmed on the partner's checksum, size and type; still needs a second person");
});

test("production release needs the media_scan_policy manual-review permission, not a reviewer's opinion", async () => {
  const blocked = await world({ PAWSPACE_MEDIA_ENV: "production" });
  const first = await blocked.register();
  await blocked.confirm(first);
  const withoutPolicy = await blocked.approve(first);
  assert.equal(withoutPolicy.proofReady, false, `an approval alone must not release production media: ${JSON.stringify(withoutPolicy)}`);
  assert.equal(withoutPolicy.releaseBasis, "blocked_unscanned");

  const permitted = await world({ PAWSPACE_MEDIA_ENV: "production" });
  const governance = await import("../lib/service-policy-governance.ts");
  const { MEDIA_SCAN_POLICY_DOMAIN } = await import("../lib/media-scan-boundary.ts");
  await governance.writeServicePolicy(permitted.db, { domain: MEDIA_SCAN_POLICY_DOMAIN, serviceCode: "grooming", cityId: "blr", config: { manualReviewPermittedWithoutScanner: true } },
    REVIEWER, "Bengaluru pilot: no scanner yet; grooming proof approved by named reviewers only");
  const second = await permitted.register();
  await permitted.confirm(second);
  const withPolicy = await permitted.approve(second);
  assert.equal(withPolicy.proofReady, true, `the explicitly set policy releases it: ${JSON.stringify(withPolicy)}`);
  assert.equal(withPolicy.releaseBasis, "manual_review_policy");
  assert.equal(withPolicy.scanVerdict, "not_scanned", "and the scanner column still tells the truth");
});

test("a bucket bound with no byte-upload path breaks every confirmation, which is what the production-config guard prevents", async () => {
  const { register, confirm } = await world({ PAWSPACE_MEDIA_ENV: "production", PAWSPACE_MEDIA_BUCKET: emptyBucket() });
  const storage = await import("../lib/media-storage-adapter.ts");
  assert.equal((await storage.mediaStorageStatus()).connected, true, "the binding is honoured as authoritative");
  const issued = await register();
  const refused = await refusal(confirm(issued));
  assert.ok(refused, "the partner's observation is no longer accepted once a bucket is bound");
  assert.equal(refused.status, 409, refused.body);
  assert.match(refused.body, /stored_object_missing/);
});

function runProdConfig(env) {
  const dir = mkdtempSync(path.join(tmpdir(), "prod-config-"));
  mkdirSync(path.join(dir, "dist", "server"), { recursive: true });
  writeFileSync(path.join(dir, "dist", "server", "wrangler.json"), JSON.stringify({ name: "pawspace-tech-platform", main: "index.js", vars: {} }));
  const script = new URL("../scripts/prod-config.mjs", import.meta.url).pathname;
  try { return { status: 0, stderr: "", stdout: execFileSync(process.execPath, [script], { cwd: dir, env: { PATH: process.env.PATH, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (error) { return { status: Number(error.status), stdout: String(error.stdout || ""), stderr: String(error.stderr || "") }; }
}
const GUARD = /PRODUCTION_R2_BUCKET_NAME is set but no byte-upload path exists/;

test("production config refuses a media bucket while proof is metadata-only, and allows it only once declared ready", () => {
  const withBucket = runProdConfig({ PRODUCTION_R2_BUCKET_NAME: "pawspace-prod-media" });
  assert.notEqual(withBucket.status, 0);
  assert.match(withBucket.stderr, GUARD, "a bucket without a byte-upload path must be refused with the pilot policy named");
  assert.doesNotMatch(runProdConfig({ PRODUCTION_R2_BUCKET_NAME: "pawspace-prod-media", PRODUCTION_MEDIA_OBJECT_UPLOAD_READY: "true" }).stderr, GUARD, "an explicit declaration lifts this refusal (other production requirements still apply)");
  assert.doesNotMatch(runProdConfig({}).stderr, GUARD, "no bucket, no refusal: metadata-only is the pilot default");
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
