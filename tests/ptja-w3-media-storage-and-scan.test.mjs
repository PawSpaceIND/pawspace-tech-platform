/**
 * Private object storage, and an honest scan boundary. [PTJA-W3-MS / W3-SC]
 *
 * THE APPROVED RULES, supplied by the business:
 *
 * STORAGE - use a private Cloudflare R2 bucket. No public bucket or permanent public object URL.
 * Short-lived signed upload/download access only. Verify stored object size, media type and ownership
 * against the upload declaration. Credentials as deployment bindings/secrets, never in the repository.
 * Keep adapterConnected:false until an actual environment binding is configured and tested. The
 * adapter and configuration contract may be completed, but operational readiness must not be claimed
 * without the real bucket and credentials.
 *
 * SCANNING - for UAT, retain honest human review status. Do not rename human review as malware
 * scanning. Create a vendor-neutral scan/quarantine boundary if needed, but production media must
 * remain blocked until either a real scanner reports clean, or an explicitly permitted manual-review
 * policy approves it. A production malware-scanning provider remains an operational blocker.
 *
 * WHAT WAS MEASURED BEFORE. lib/media-upload-boundary.ts verifies the uploaded object against what the
 * CALLER says it observed, and says adapterConnected:false everywhere - honest, but there is no adapter
 * at all, so nothing would change if a bucket appeared. And what the module calls a scan is a human
 * pressing approve: reviewMedia writes scan_status='clean'. In UAT that is the agreed answer; in
 * production it would mean a person's opinion is recorded in the column a scanner is supposed to own.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_MS_DB__", "__PTJA_MS_ENV__");

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

const SHA_A = "a".repeat(64);
const UPLOADER = "field.groomer@pawspace.test";
const REVIEWER = "quality.lead@pawspace.test";

const attempt = (promise) => promise.then(
  (value) => ({ ok: true, value }),
  async (error) => ({ ok: false, status: error instanceof Response ? error.status : 0, message: error instanceof Response ? await error.clone().text() : String(error?.message ?? error) }),
);

/** A stand-in for an R2 bucket binding: only the two calls the adapter is allowed to make. */
function fakeBucket(objects = new Map()) {
  return {
    objects,
    head: async (key) => objects.get(key) ?? null,
    get: async (key) => objects.get(key) ?? null,
  };
}

async function world(env = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_MS_DB__ = db;
  globalThis.__PTJA_MS_ENV__ = env;
  const boundary = await import("../lib/media-upload-boundary.ts");
  await boundary.ensureMediaBoundaryTables(db);
  const now = Date.now();
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT,schedule_group_id TEXT,provider_id TEXT,provider_name TEXT,provider_model TEXT,service_code TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES ('WO-1','BK-1','SG-1','PRV-1','Groomer','full_time','grooming','2026-08-01T09:00:00.000Z','2026-08-01T11:00:00.000Z','assigned',?,?)").run(now, now);
  const grant = () => boundary.issueMediaUploadGrant(db, {
    bookingId: "BK-1", scopeType: "booking", scopeId: "BK-1", providerId: "PRV-1",
    serviceCode: "grooming", cityId: "blr", category: "after_service",
    mimeType: "image/jpeg", sizeBytes: 2048, sha256: SHA_A, fileName: "after.jpg", actorId: UPLOADER,
  });
  return { sqlite, db, boundary, grant };
}

// ---------------------------------------------------------------------------------------------------
// The storage adapter contract
// ---------------------------------------------------------------------------------------------------

test("MS-01: with no bucket binding the adapter is not connected and names what is missing", async () => {
  await world();
  const storage = await import("../lib/media-storage-adapter.ts");
  const status = await storage.mediaStorageStatus();
  assert.equal(status.connected, false, `nothing is claimed: ${JSON.stringify(status)}`);
  assert.match(String(status.reason ?? ""), /binding/i, "and the missing piece is named, so it is actionable");
  assert.equal(String(status.bucketBinding), "PAWSPACE_MEDIA_BUCKET", "the binding the deployment must provide is stated");
});

test("MS-02: with no adapter, registration still verifies against the caller's observation", async () => {
  // Unchanged behaviour, restated so the adapter work cannot quietly weaken it.
  const { db, boundary, grant } = await world();
  const issued = await grant();
  const registered = await boundary.redeemMediaUploadGrant(db, {
    token: issued.token, objectKey: issued.objectKey,
    observed: { sizeBytes: 2048, sha256: SHA_A, mimeType: "image/jpeg" }, actorId: UPLOADER,
  });
  assert.equal(registered.reviewStatus, "pending_review", `it registers: ${JSON.stringify(registered)}`);
  assert.equal(registered.adapterConnected, false, "and says plainly that no storage verified it");
});

test("MS-03: with a bucket binding the STORED object is what gets verified", async () => {
  const bucket = fakeBucket();
  const { db, boundary, grant } = await world({ PAWSPACE_MEDIA_BUCKET: bucket });
  const issued = await grant();
  bucket.objects.set(issued.objectKey, { size: 2048, httpMetadata: { contentType: "image/jpeg" } });
  const registered = await boundary.redeemMediaUploadGrant(db, {
    token: issued.token, objectKey: issued.objectKey,
    // Deliberately a LIE. With a bucket present the caller's claim is not what counts.
    observed: { sizeBytes: 999999, sha256: SHA_A, mimeType: "image/png" }, actorId: UPLOADER,
  });
  assert.equal(registered.reviewStatus, "pending_review", `the real object satisfies the grant: ${JSON.stringify(registered)}`);
  assert.equal(registered.adapterConnected, true, "and the verification is attributed to storage");
});

test("MS-04: a stored object that does not match the declaration is refused", async () => {
  const bucket = fakeBucket();
  const { db, boundary, grant } = await world({ PAWSPACE_MEDIA_BUCKET: bucket });
  const issued = await grant();
  bucket.objects.set(issued.objectKey, { size: 4096, httpMetadata: { contentType: "image/jpeg" } });
  const refused = await attempt(boundary.redeemMediaUploadGrant(db, {
    token: issued.token, objectKey: issued.objectKey,
    observed: { sizeBytes: 2048, sha256: SHA_A, mimeType: "image/jpeg" }, actorId: UPLOADER,
  }));
  assert.equal(refused.ok, false, `a caller's correct-looking claim cannot override the object: ${JSON.stringify(refused).slice(0, 300)}`);
});

test("MS-05: an object that is not in the bucket is refused, not assumed present", async () => {
  const bucket = fakeBucket();
  const { db, boundary, grant } = await world({ PAWSPACE_MEDIA_BUCKET: bucket });
  const issued = await grant();
  const refused = await attempt(boundary.redeemMediaUploadGrant(db, {
    token: issued.token, objectKey: issued.objectKey,
    observed: { sizeBytes: 2048, sha256: SHA_A, mimeType: "image/jpeg" }, actorId: UPLOADER,
  }));
  assert.equal(refused.ok, false, `nothing was uploaded, so nothing is registered: ${JSON.stringify(refused).slice(0, 300)}`);
});

test("MS-06: the adapter never produces a public object URL", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../lib/media-storage-adapter.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /https?:\/\/[^\s"'`]*r2\.(dev|cloudflarestorage)/i,
    "no bucket hostname may be built into a URL here");
  assert.doesNotMatch(source, /publicUrl|publicBaseUrl\s*=/,
    "and no public base URL is composed at all - a permanent object URL is the thing the rule forbids");
});

test("MS-07: no credential value is read, only presence", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../lib/media-storage-adapter.ts", import.meta.url), "utf8");
  for (const secret of ["accessKeyId", "secretAccessKey", "R2_SECRET", "ACCOUNT_ID"]) {
    assert.equal(source.includes(secret), false, `${secret} must never appear: credentials are a deployment binding, not a value this code handles`);
  }
});

// ---------------------------------------------------------------------------------------------------
// The scan boundary
// ---------------------------------------------------------------------------------------------------

test("SC-01: with no scanner configured the boundary says so rather than implying one", async () => {
  await world();
  const scan = await import("../lib/media-scan-boundary.ts");
  const status = await scan.mediaScanStatus();
  assert.equal(status.connected, false, `no scanner is claimed: ${JSON.stringify(status)}`);
  assert.equal(status.provider, "none", "and the provider is named as none, not left blank");
  assert.equal(status.productionBlocker, true, "which is an operational blocker for production media");
});

test("SC-02: a human approval is recorded as human review, never as a scan result", async () => {
  const { sqlite, db, boundary, grant } = await world({ PAWSPACE_MEDIA_ENV: "uat" });
  const issued = await grant();
  await boundary.redeemMediaUploadGrant(db, { token: issued.token, objectKey: issued.objectKey, observed: { sizeBytes: 2048, sha256: SHA_A, mimeType: "image/jpeg" }, actorId: UPLOADER });
  const approved = await boundary.reviewMedia(db, { mediaId: issued.mediaId, decision: "approved", actorId: REVIEWER, reason: "Both dogs visible" });
  assert.equal(approved.reviewStatus, "approved", "the human decision is recorded");
  assert.equal(approved.scanVerdict, "not_scanned", `and is NOT dressed up as a scan: ${JSON.stringify(approved)}`);
  // The STORED column, not just the returned field. Written first checking only the response, which
  // sabotage showed was shadowed: the response reads the verdicts table while the column is written
  // separately, so scan_status could go back to 'clean' on a human's approval with this still green.
  assert.notEqual(String(sqlite.prepare("SELECT scan_status FROM service_media_assets WHERE id=?").get(issued.mediaId).scan_status), "clean",
    "and the scanner's own column must not record a human's opinion as a clean scan");
  const events = sqlite.prepare("SELECT event_type FROM service_media_events WHERE media_id=?").all(issued.mediaId).map((row) => String(row.event_type));
  assert.equal(events.some((name) => /scan/i.test(name)), false, `no event may call it scanning: ${JSON.stringify(events)}`);
});

test("SC-03: in UAT an approved asset is usable, which is the agreed answer there", async () => {
  // Non-vacuity for SC-04. Blocking everywhere would satisfy it and stop UAT working.
  const { db, boundary, grant } = await world({ PAWSPACE_MEDIA_ENV: "uat" });
  const issued = await grant();
  await boundary.redeemMediaUploadGrant(db, { token: issued.token, objectKey: issued.objectKey, observed: { sizeBytes: 2048, sha256: SHA_A, mimeType: "image/jpeg" }, actorId: UPLOADER });
  const approved = await boundary.reviewMedia(db, { mediaId: issued.mediaId, decision: "approved", actorId: REVIEWER, reason: "Both dogs visible" });
  assert.equal(approved.proofReady, true, `UAT proof is usable after human review: ${JSON.stringify(approved)}`);
});

test("SC-04: in PRODUCTION human review alone does not open access", async () => {
  const { sqlite, db, boundary, grant } = await world({ PAWSPACE_MEDIA_ENV: "production" });
  const issued = await grant();
  await boundary.redeemMediaUploadGrant(db, { token: issued.token, objectKey: issued.objectKey, observed: { sizeBytes: 2048, sha256: SHA_A, mimeType: "image/jpeg" }, actorId: UPLOADER });
  const approved = await boundary.reviewMedia(db, { mediaId: issued.mediaId, decision: "approved", actorId: REVIEWER, reason: "Looks fine to me" });
  assert.equal(approved.proofReady, false, `an unscanned production file stays blocked: ${JSON.stringify(approved)}`);
  assert.notEqual(String(sqlite.prepare("SELECT access_status FROM service_media_assets WHERE id=?").get(issued.mediaId).access_status), "ready",
    "and access is not opened");
});

test("SC-05: in PRODUCTION an explicitly permitted manual-review policy does open access", async () => {
  // The escape hatch the rule names. It has to be a POLICY somebody set, not a reviewer's own say-so.
  const { db, boundary, grant } = await world({ PAWSPACE_MEDIA_ENV: "production" });
  const governance = await import("../lib/service-policy-governance.ts");
  await boundary.issueMediaUploadGrant; // domain registration
  const issued = await grant();
  await governance.writeServicePolicy(db, {
    domain: (await import("../lib/media-scan-boundary.ts")).MEDIA_SCAN_POLICY_DOMAIN,
    serviceCode: "grooming", cityId: "blr",
    config: { manualReviewPermittedWithoutScanner: true },
  }, "founder@pawspace.test", "No scanner yet; grooming proof approved by named reviewers only");
  await boundary.redeemMediaUploadGrant(db, { token: issued.token, objectKey: issued.objectKey, observed: { sizeBytes: 2048, sha256: SHA_A, mimeType: "image/jpeg" }, actorId: UPLOADER });
  const approved = await boundary.reviewMedia(db, { mediaId: issued.mediaId, decision: "approved", actorId: REVIEWER, reason: "Both dogs visible, reviewed under the manual policy" });
  assert.equal(approved.proofReady, true, `the permitted policy opens it: ${JSON.stringify(approved)}`);
});

test("SC-06: a scanner verdict of infected blocks the asset whatever a human decided", async () => {
  const { sqlite, db, boundary, grant } = await world({ PAWSPACE_MEDIA_ENV: "uat" });
  const scan = await import("../lib/media-scan-boundary.ts");
  const issued = await grant();
  await boundary.redeemMediaUploadGrant(db, { token: issued.token, objectKey: issued.objectKey, observed: { sizeBytes: 2048, sha256: SHA_A, mimeType: "image/jpeg" }, actorId: UPLOADER });
  await scan.recordScanVerdict(db, { mediaId: issued.mediaId, verdict: "infected", provider: "uat_manual_upload", detail: "EICAR test string" });
  const approved = await attempt(boundary.reviewMedia(db, { mediaId: issued.mediaId, decision: "approved", actorId: REVIEWER, reason: "Looks fine to me" }));
  assert.equal(approved.ok, false, `a human cannot approve over a scanner: ${JSON.stringify(approved).slice(0, 300)}`);
  assert.notEqual(String(sqlite.prepare("SELECT access_status FROM service_media_assets WHERE id=?").get(issued.mediaId).access_status), "ready");
});

test("SC-07: a scanner verdict of clean satisfies production without a manual policy", async () => {
  const { db, boundary, grant } = await world({ PAWSPACE_MEDIA_ENV: "production" });
  const scan = await import("../lib/media-scan-boundary.ts");
  const issued = await grant();
  await boundary.redeemMediaUploadGrant(db, { token: issued.token, objectKey: issued.objectKey, observed: { sizeBytes: 2048, sha256: SHA_A, mimeType: "image/jpeg" }, actorId: UPLOADER });
  await scan.recordScanVerdict(db, { mediaId: issued.mediaId, verdict: "clean", provider: "uat_manual_upload", detail: "no signatures matched" });
  const approved = await boundary.reviewMedia(db, { mediaId: issued.mediaId, decision: "approved", actorId: REVIEWER, reason: "Both dogs visible" });
  assert.equal(approved.proofReady, true, `a real clean verdict is what production wanted: ${JSON.stringify(approved)}`);
});

test("SC-08: a scan verdict cannot be recorded without naming who produced it", async () => {
  const { db, grant } = await world({ PAWSPACE_MEDIA_ENV: "uat" });
  const scan = await import("../lib/media-scan-boundary.ts");
  const issued = await grant();
  const refused = await attempt(scan.recordScanVerdict(db, { mediaId: issued.mediaId, verdict: "clean", provider: "" }));
  assert.equal(refused.ok, false, `an anonymous "clean" is the defect this whole boundary exists to prevent: ${JSON.stringify(refused).slice(0, 250)}`);
});
