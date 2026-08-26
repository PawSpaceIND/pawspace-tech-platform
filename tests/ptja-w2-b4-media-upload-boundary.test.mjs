/**
 * PawSpace Total Journey Audit — W2-B4-M04, the signed-upload boundary for service media.
 *
 * THE APPROVED RULE (business decision, supplied in full):
 *   1. An authenticated user requests a short-lived upload token.
 *   2. The server verifies booking assignment and permitted media category.
 *   3. The token is restricted by object key, file type, size and expiry.
 *   4. The file uploads directly to private storage.
 *   5. The server verifies the uploaded object before registration.
 *   6. Media begins as PENDING_REVIEW.
 *   7. The uploader cannot approve their own media.
 *   8. The customer receives only a short-lived signed read URL.
 *   9. Replacement, deletion and approval are audited.
 *   Reject executable formats, arbitrary external URLs, cross-booking object keys and reused or
 *   expired upload tokens.
 *
 * WHAT WAS MEASURED BEFORE THIS CHANGE. app/api/service-media and app/api/training-session-media issue
 * no upload grant at all - their POST answers storage:{mode:"not_connected"} - and service-media's
 * PATCH confirm_upload accepts ANY opaque object id from ANY bookings.manage actor, with no token, no
 * expiry, no binding to the prepared asset's booking and no check that the object matches what was
 * declared. The four sibling proof libraries (walking, food, boarding, sitting/taxi) each mint a
 * single-use hashed token with a 15-minute expiry and verify it on finalisation. Service media was
 * left on the weaker path. This closes it, and does so once, in a shared authority rather than a sixth
 * copy of the same code.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_MUB_DB__", "__PTJA_MUB_ENV__");

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
const SHA_B = "b".repeat(64);

const UPLOADER = "field.groomer@pawspace.test";
const REVIEWER = "quality.lead@pawspace.test";

const STAFF = {
  "content-type": "application/json",
  "oai-authenticated-user-email": UPLOADER,
  "oai-authenticated-user-full-name": "Field%20groomer",
  "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
};

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_MUB_DB__ = db;
  globalThis.__PTJA_MUB_ENV__ = {};
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const now = Date.now();
  for (const [id, email, name] of [["USR-UP", UPLOADER, "Field groomer"], ["USR-QA", REVIEWER, "Quality lead"]]) {
    await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,'manager','active',?,?)").bind(id, email, name, now, now).run();
  }
  const boundary = await import("../lib/media-upload-boundary.ts");
  await boundary.ensureMediaBoundaryTables(db);
  // Step 2 of the approved rule is "the server verifies booking assignment". The work orders are the
  // record that proves it, so the boundary reads them rather than trusting the caller's own claim.
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT,schedule_group_id TEXT,provider_id TEXT,provider_name TEXT,provider_model TEXT,service_code TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,created_at INTEGER,updated_at INTEGER)");
  for (const bookingId of ["BK-GROOM-1", "BK-GROOM-2"]) {
    sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES (?,?,'SG-1','PRV-GROOMER-1','Groomer','full_time','grooming','2026-08-01T09:00:00.000Z','2026-08-01T11:00:00.000Z','assigned',?,?)")
      .run(`WO-${bookingId}`, bookingId, now, now);
  }
  return { sqlite, db, boundary, now };
}

const GRANT = {
  bookingId: "BK-GROOM-1",
  scopeType: "booking",
  scopeId: "BK-GROOM-1",
  providerId: "PRV-GROOMER-1",
  serviceCode: "grooming",
  cityId: "blr",
  category: "after_service",
  mimeType: "image/jpeg",
  sizeBytes: 2048,
  sha256: SHA_A,
  fileName: "after.jpg",
  actorId: UPLOADER,
};

const attempt = (promise) => promise.then(
  (value) => ({ ok: true, value }),
  async (error) => ({ ok: false, status: error instanceof Response ? error.status : 0, message: error instanceof Response ? await error.clone().text() : String(error?.message ?? error) }),
);

// ---------------------------------------------------------------------------------------------------
// Steps 1-3 — a short-lived token, restricted by object key, file type, size and expiry
// ---------------------------------------------------------------------------------------------------

test("M04-01: a granted upload carries an object key, a file type, a size ceiling and an expiry", async () => {
  const { boundary, db, now } = await world();
  const grant = await boundary.issueMediaUploadGrant(db, GRANT);
  assert.ok(grant.token && grant.token.length >= 32, `a token is minted: ${JSON.stringify(grant).slice(0, 300)}`);
  assert.ok(grant.objectKey && !grant.objectKey.includes("://"), "the object key is opaque, not a URL");
  assert.ok(grant.objectKey.includes(GRANT.scopeId), "and is bound to this booking");
  assert.equal(grant.mimeType, "image/jpeg", "the token pins the declared file type");
  assert.equal(grant.sizeBytes, 2048, "and the declared size");
  assert.ok(grant.expiresAt > now && grant.expiresAt <= now + 3_600_000, `the expiry is short-lived: ${grant.expiresAt - now}ms`);
  assert.equal(grant.upload.adapterConnected, false, "no storage adapter is claimed to be connected");
});

test("M04-02: the token is stored hashed, never in clear text", async () => {
  const { boundary, db, sqlite } = await world();
  const grant = await boundary.issueMediaUploadGrant(db, GRANT);
  const row = sqlite.prepare("SELECT * FROM media_upload_grants WHERE id=?").get(grant.grantId);
  assert.ok(row, "the grant is persisted");
  assert.notEqual(String(row.token_hash), grant.token, "the stored value is not the token itself");
  assert.equal(JSON.stringify(row).includes(grant.token), false, "and the token appears nowhere on the row");
});

test("M04-03: a media category the policy does not permit for this service is refused", async () => {
  const { boundary, db } = await world();
  const refused = await attempt(boundary.issueMediaUploadGrant(db, { ...GRANT, category: "customer_identity_document" }));
  assert.equal(refused.ok, false, `an unlisted category must not receive an upload token: ${JSON.stringify(refused).slice(0, 300)}`);
});

test("M04-04: a permitted category still receives a token", async () => {
  // Non-vacuity for M04-03. Refusing every category would satisfy it and break proof capture.
  const { boundary, db } = await world();
  for (const category of ["before_service", "after_service", "service_issue"]) {
    const granted = await attempt(boundary.issueMediaUploadGrant(db, { ...GRANT, category }));
    assert.equal(granted.ok, true, `${category} is a permitted PawSpace media category: ${JSON.stringify(granted).slice(0, 300)}`);
  }
});

test("M04-05: an oversized or empty declaration is refused before any token is minted", async () => {
  const { boundary, db, sqlite } = await world();
  for (const sizeBytes of [0, -1, 10_000_001]) {
    const refused = await attempt(boundary.issueMediaUploadGrant(db, { ...GRANT, sizeBytes }));
    assert.equal(refused.ok, false, `size ${sizeBytes} must be refused: ${JSON.stringify(refused).slice(0, 200)}`);
  }
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM media_upload_grants").get().c, 0, "and no grant row is left behind");
});

// ---------------------------------------------------------------------------------------------------
// Executable formats and external URLs
// ---------------------------------------------------------------------------------------------------

test("M04-06: an executable file type never receives an upload token", async () => {
  const { boundary, db } = await world();
  for (const mimeType of ["application/x-msdownload", "application/x-sh", "text/html", "image/svg+xml", "application/octet-stream"]) {
    const refused = await attempt(boundary.issueMediaUploadGrant(db, { ...GRANT, mimeType }));
    assert.equal(refused.ok, false, `${mimeType} must be refused: ${JSON.stringify(refused).slice(0, 200)}`);
  }
});

test("M04-07: an executable file name is refused even under an image content type", async () => {
  const { boundary, db } = await world();
  for (const fileName of ["payload.exe", "proof.jpg.sh", "run.bat", "shell.php", "x.svg"]) {
    const refused = await attempt(boundary.issueMediaUploadGrant(db, { ...GRANT, fileName }));
    assert.equal(refused.ok, false, `a file named ${fileName} must be refused: ${JSON.stringify(refused).slice(0, 200)}`);
  }
});

test("M04-08: the Control Center cannot store a policy that permits an executable type", async () => {
  // The permitted types are a business setting, editable per vertical and per city. That is exactly why
  // the executable refusal cannot live only in the default value: the write path must refuse it too.
  const { boundary, db } = await world();
  const governance = await import("../lib/service-policy-governance.ts");
  const refused = await attempt(governance.writeServicePolicy(db, {
    domain: boundary.MEDIA_UPLOAD_POLICY_DOMAIN, serviceCode: "grooming", cityId: "blr",
    config: { allowedMimeTypes: ["image/jpeg", "application/x-msdownload"] },
  }, "founder@pawspace.test", "Widening the accepted proof formats"));
  assert.equal(refused.ok, false, `an executable MIME type must not be storable: ${JSON.stringify(refused).slice(0, 300)}`);
});

test("M04-09: a stored policy listing an executable type cannot be evaluated at all", async () => {
  // Belt and braces on the SAME rule, at the other end. M04-08 proves the write path refuses it; this
  // proves that a row which reached the table by any other route - a migration, a direct edit, a future
  // write path - is refused when it is READ, so no grant is ever minted against it.
  //
  // Written first as "the runtime refuses an executable type regardless of configuration", pointed at
  // the mime check inside issueMediaUploadGrant. Sabotage showed that check is unreachable through
  // configuration: deleting it left this test green, because the read-time validator had already
  // refused the row. The test now names the control that is actually doing the work.
  const { boundary, db, sqlite } = await world();
  await boundary.issueMediaUploadGrant(db, GRANT); // forces the domain seed
  sqlite.prepare("UPDATE service_policy_configs SET config_json=? WHERE policy_domain=?")
    .run(JSON.stringify({ permittedCategories: ["after_service"], allowedMimeTypes: ["application/x-msdownload"], minSizeBytes: 1, maxSizeBytes: 10000000, uploadTokenTtlSeconds: 900, readUrlTtlSeconds: 300, requireSeparateApprover: true }), boundary.MEDIA_UPLOAD_POLICY_DOMAIN);
  const executable = await attempt(boundary.issueMediaUploadGrant(db, { ...GRANT, mimeType: "application/x-msdownload", fileName: "payload.bin" }));
  assert.equal(executable.ok, false, `no grant may be minted against that row: ${JSON.stringify(executable).slice(0, 300)}`);
  const permitted = await attempt(boundary.issueMediaUploadGrant(db, { ...GRANT, mimeType: "image/jpeg" }));
  assert.equal(permitted.ok, false,
    `and the row is refused outright rather than partly honoured: ${JSON.stringify(permitted).slice(0, 300)}`);
  assert.match(String(permitted.message), /invalid|outside the PawSpace media floor/i,
    `for the stated reason: ${String(permitted.message).slice(0, 300)}`);
});

test("M04-10: an external URL cannot be presented as the uploaded object", async () => {
  const { boundary, db } = await world();
  const grant = await boundary.issueMediaUploadGrant(db, GRANT);
  for (const objectKey of ["https://attacker.example.test/not-an-object.jpg", "//evil.test/x.jpg", "s3://bucket/key"]) {
    const refused = await attempt(boundary.redeemMediaUploadGrant(db, { token: grant.token, objectKey, observed: { sizeBytes: 2048, sha256: SHA_A, mimeType: "image/jpeg" }, actorId: UPLOADER }));
    assert.equal(refused.ok, false, `${objectKey} must be refused: ${JSON.stringify(refused).slice(0, 200)}`);
  }
});

// ---------------------------------------------------------------------------------------------------
// Cross-booking keys, reuse, expiry, tampering
// ---------------------------------------------------------------------------------------------------

test("M04-11: an object key belonging to another booking is refused", async () => {
  const { boundary, db } = await world();
  const mine = await boundary.issueMediaUploadGrant(db, GRANT);
  const theirs = await boundary.issueMediaUploadGrant(db, { ...GRANT, bookingId: "BK-GROOM-2", scopeId: "BK-GROOM-2" });
  const refused = await attempt(boundary.redeemMediaUploadGrant(db, { token: mine.token, objectKey: theirs.objectKey, observed: { sizeBytes: 2048, sha256: SHA_A, mimeType: "image/jpeg" }, actorId: UPLOADER }));
  assert.equal(refused.ok, false, `a token must only redeem its own object key: ${JSON.stringify(refused).slice(0, 300)}`);
});

test("M04-12: a redeemed token cannot be used a second time", async () => {
  const { boundary, db } = await world();
  const grant = await boundary.issueMediaUploadGrant(db, GRANT);
  const observed = { sizeBytes: 2048, sha256: SHA_A, mimeType: "image/jpeg" };
  const first = await attempt(boundary.redeemMediaUploadGrant(db, { token: grant.token, objectKey: grant.objectKey, observed, actorId: UPLOADER }));
  assert.equal(first.ok, true, `the first redemption succeeds: ${JSON.stringify(first).slice(0, 300)}`);
  const second = await attempt(boundary.redeemMediaUploadGrant(db, { token: grant.token, objectKey: grant.objectKey, observed, actorId: UPLOADER }));
  assert.equal(second.ok, false, `a reused token must be refused: ${JSON.stringify(second).slice(0, 300)}`);
});

test("M04-13: an expired token is refused", async () => {
  const { boundary, db, sqlite } = await world();
  const grant = await boundary.issueMediaUploadGrant(db, GRANT);
  sqlite.prepare("UPDATE media_upload_grants SET expires_at=? WHERE id=?").run(Date.now() - 1000, grant.grantId);
  const refused = await attempt(boundary.redeemMediaUploadGrant(db, { token: grant.token, objectKey: grant.objectKey, observed: { sizeBytes: 2048, sha256: SHA_A, mimeType: "image/jpeg" }, actorId: UPLOADER }));
  assert.equal(refused.ok, false, `an expired token must be refused: ${JSON.stringify(refused).slice(0, 300)}`);
});

test("M04-14: a token whose secret does not match the stored hash is refused", async () => {
  const { boundary, db } = await world();
  const grant = await boundary.issueMediaUploadGrant(db, GRANT);
  const forged = `${grant.grantId}.${"0".repeat(64)}`;
  const refused = await attempt(boundary.redeemMediaUploadGrant(db, { token: forged, objectKey: grant.objectKey, observed: { sizeBytes: 2048, sha256: SHA_A, mimeType: "image/jpeg" }, actorId: UPLOADER }));
  assert.equal(refused.ok, false, `guessing the grant id must not be enough: ${JSON.stringify(refused).slice(0, 300)}`);
});

// ---------------------------------------------------------------------------------------------------
// Step 5 — the server verifies the uploaded object before registration
// ---------------------------------------------------------------------------------------------------

test("M04-15: an object whose checksum does not match the declaration is not registered", async () => {
  const { boundary, db, sqlite } = await world();
  const grant = await boundary.issueMediaUploadGrant(db, GRANT);
  const refused = await attempt(boundary.redeemMediaUploadGrant(db, { token: grant.token, objectKey: grant.objectKey, observed: { sizeBytes: 2048, sha256: SHA_B, mimeType: "image/jpeg" }, actorId: UPLOADER }));
  assert.equal(refused.ok, false, `a checksum mismatch must refuse registration: ${JSON.stringify(refused).slice(0, 300)}`);
  const asset = sqlite.prepare("SELECT access_status FROM service_media_assets WHERE id=?").get(grant.mediaId);
  assert.equal(String(asset.access_status), "pending_upload", "and the asset stays unregistered");
});

test("M04-16: an object whose size or type does not match the declaration is not registered", async () => {
  const { boundary, db } = await world();
  const grant = await boundary.issueMediaUploadGrant(db, GRANT);
  for (const observed of [{ sizeBytes: 4096, sha256: SHA_A, mimeType: "image/jpeg" }, { sizeBytes: 2048, sha256: SHA_A, mimeType: "image/png" }]) {
    const refused = await attempt(boundary.redeemMediaUploadGrant(db, { token: grant.token, objectKey: grant.objectKey, observed, actorId: UPLOADER }));
    assert.equal(refused.ok, false, `${JSON.stringify(observed)} must be refused: ${JSON.stringify(refused).slice(0, 200)}`);
  }
});

test("M04-17: registration without an observed object is refused", async () => {
  // "The server verifies the uploaded object" cannot be satisfied by the caller simply not saying.
  const { boundary, db } = await world();
  const grant = await boundary.issueMediaUploadGrant(db, GRANT);
  const refused = await attempt(boundary.redeemMediaUploadGrant(db, { token: grant.token, objectKey: grant.objectKey, actorId: UPLOADER }));
  assert.equal(refused.ok, false, `an absent observation must not be treated as a match: ${JSON.stringify(refused).slice(0, 300)}`);
});

// ---------------------------------------------------------------------------------------------------
// Steps 6-7 — PENDING_REVIEW, and no self-approval
// ---------------------------------------------------------------------------------------------------

test("M04-18: registered media begins PENDING_REVIEW and is not proof-ready", async () => {
  const { boundary, db, sqlite } = await world();
  const grant = await boundary.issueMediaUploadGrant(db, GRANT);
  const registered = await boundary.redeemMediaUploadGrant(db, { token: grant.token, objectKey: grant.objectKey, observed: { sizeBytes: 2048, sha256: SHA_A, mimeType: "image/jpeg" }, actorId: UPLOADER });
  assert.equal(registered.reviewStatus, "pending_review", `media begins PENDING_REVIEW: ${JSON.stringify(registered).slice(0, 300)}`);
  assert.equal(registered.proofReady, false, "and is not yet usable as proof");
  const asset = sqlite.prepare("SELECT review_status,access_status,scan_status FROM service_media_assets WHERE id=?").get(grant.mediaId);
  assert.equal(String(asset.review_status), "pending_review", "the stored review state agrees");
  assert.notEqual(String(asset.access_status), "ready", "and access is not open");
});

test("M04-19: the uploader cannot approve their own media", async () => {
  const { boundary, db } = await world();
  const grant = await boundary.issueMediaUploadGrant(db, GRANT);
  await boundary.redeemMediaUploadGrant(db, { token: grant.token, objectKey: grant.objectKey, observed: { sizeBytes: 2048, sha256: SHA_A, mimeType: "image/jpeg" }, actorId: UPLOADER });
  const refused = await attempt(boundary.reviewMedia(db, { mediaId: grant.mediaId, decision: "approved", actorId: UPLOADER, reason: "Looks fine to me" }));
  assert.equal(refused.ok, false, `self-approval must be refused: ${JSON.stringify(refused).slice(0, 300)}`);
});

test("M04-20: a second reviewer can approve, and the approval is audited", async () => {
  // Non-vacuity for M04-19, and step 9 for approval.
  const { boundary, db, sqlite } = await world();
  const grant = await boundary.issueMediaUploadGrant(db, GRANT);
  await boundary.redeemMediaUploadGrant(db, { token: grant.token, objectKey: grant.objectKey, observed: { sizeBytes: 2048, sha256: SHA_A, mimeType: "image/jpeg" }, actorId: UPLOADER });
  const approved = await attempt(boundary.reviewMedia(db, { mediaId: grant.mediaId, decision: "approved", actorId: REVIEWER, reason: "Both dogs visible, timestamp matches the visit" }));
  assert.equal(approved.ok, true, `a separate reviewer may approve: ${JSON.stringify(approved).slice(0, 300)}`);
  assert.equal(approved.value.reviewStatus, "approved", "the review state advances");
  const events = sqlite.prepare("SELECT event_type,actor_id FROM service_media_events WHERE media_id=? ORDER BY created_at").all(grant.mediaId);
  assert.ok(events.some((row) => String(row.event_type).includes("approved") && String(row.actor_id) === REVIEWER),
    `the approval is audited against the approver: ${JSON.stringify(events).slice(0, 400)}`);
});

test("M04-21: a rejection is recorded and does not open access", async () => {
  const { boundary, db, sqlite } = await world();
  const grant = await boundary.issueMediaUploadGrant(db, GRANT);
  await boundary.redeemMediaUploadGrant(db, { token: grant.token, objectKey: grant.objectKey, observed: { sizeBytes: 2048, sha256: SHA_A, mimeType: "image/jpeg" }, actorId: UPLOADER });
  const rejected = await boundary.reviewMedia(db, { mediaId: grant.mediaId, decision: "rejected", actorId: REVIEWER, reason: "The photo shows the wrong pet" });
  assert.equal(rejected.reviewStatus, "rejected", "the rejection is recorded");
  const asset = sqlite.prepare("SELECT access_status FROM service_media_assets WHERE id=?").get(grant.mediaId);
  assert.notEqual(String(asset.access_status), "ready", "and access stays closed");
});

// ---------------------------------------------------------------------------------------------------
// Step 8 — the customer receives only a short-lived signed read URL
// ---------------------------------------------------------------------------------------------------

test("M04-22: customer read access is a short-lived signed grant, not a durable object reference", async () => {
  const { boundary, db, sqlite } = await world();
  const grant = await boundary.issueMediaUploadGrant(db, GRANT);
  await boundary.redeemMediaUploadGrant(db, { token: grant.token, objectKey: grant.objectKey, observed: { sizeBytes: 2048, sha256: SHA_A, mimeType: "image/jpeg" }, actorId: UPLOADER });
  await boundary.reviewMedia(db, { mediaId: grant.mediaId, decision: "approved", actorId: REVIEWER, reason: "Approved for the customer" });
  const read = await boundary.issueMediaReadGrant(db, { mediaId: grant.mediaId, audience: "customer", actorId: REVIEWER });
  assert.ok(read.expiresAt > Date.now(), "the read grant is live");
  assert.ok(read.expiresAt - Date.now() <= 3_600_000, `and short-lived: ${read.expiresAt - Date.now()}ms`);
  assert.equal(String(read.url).includes(grant.objectKey), false,
    `the customer must not receive the private object key: ${String(read.url)}`);
  const stored = sqlite.prepare("SELECT * FROM media_read_grants WHERE id=?").get(read.grantId);
  assert.equal(JSON.stringify(stored).includes(read.token), false, "and the read token is stored hashed");
});

test("M04-23: an expired read grant no longer resolves", async () => {
  const { boundary, db, sqlite } = await world();
  const grant = await boundary.issueMediaUploadGrant(db, GRANT);
  await boundary.redeemMediaUploadGrant(db, { token: grant.token, objectKey: grant.objectKey, observed: { sizeBytes: 2048, sha256: SHA_A, mimeType: "image/jpeg" }, actorId: UPLOADER });
  await boundary.reviewMedia(db, { mediaId: grant.mediaId, decision: "approved", actorId: REVIEWER, reason: "Approved for the customer" });
  const read = await boundary.issueMediaReadGrant(db, { mediaId: grant.mediaId, audience: "customer", actorId: REVIEWER });
  const live = await attempt(boundary.resolveMediaReadGrant(db, read.token));
  assert.equal(live.ok, true, `the grant resolves while live: ${JSON.stringify(live).slice(0, 300)}`);
  sqlite.prepare("UPDATE media_read_grants SET expires_at=? WHERE id=?").run(Date.now() - 1000, read.grantId);
  const dead = await attempt(boundary.resolveMediaReadGrant(db, read.token));
  assert.equal(dead.ok, false, `and stops resolving once expired: ${JSON.stringify(dead).slice(0, 300)}`);
});

test("M04-24: media that is not approved cannot be shared with the customer", async () => {
  const { boundary, db } = await world();
  const grant = await boundary.issueMediaUploadGrant(db, GRANT);
  await boundary.redeemMediaUploadGrant(db, { token: grant.token, objectKey: grant.objectKey, observed: { sizeBytes: 2048, sha256: SHA_A, mimeType: "image/jpeg" }, actorId: UPLOADER });
  const refused = await attempt(boundary.issueMediaReadGrant(db, { mediaId: grant.mediaId, audience: "customer", actorId: REVIEWER }));
  assert.equal(refused.ok, false, `PENDING_REVIEW media must not reach the customer: ${JSON.stringify(refused).slice(0, 300)}`);
});

// ---------------------------------------------------------------------------------------------------
// Step 9 — replacement and deletion are audited
// ---------------------------------------------------------------------------------------------------

test("M04-25: replacing approved media is audited, and the replacement re-enters PENDING_REVIEW", async () => {
  const { boundary, db, sqlite } = await world();
  const grant = await boundary.issueMediaUploadGrant(db, GRANT);
  await boundary.redeemMediaUploadGrant(db, { token: grant.token, objectKey: grant.objectKey, observed: { sizeBytes: 2048, sha256: SHA_A, mimeType: "image/jpeg" }, actorId: UPLOADER });
  await boundary.reviewMedia(db, { mediaId: grant.mediaId, decision: "approved", actorId: REVIEWER, reason: "Approved" });
  const replacement = await boundary.replaceMedia(db, { mediaId: grant.mediaId, actorId: UPLOADER, reason: "The first photo was blurred", mimeType: "image/jpeg", sizeBytes: 4096, sha256: SHA_B, fileName: "after-2.jpg" });
  assert.ok(replacement.mediaId && replacement.mediaId !== grant.mediaId, `a new asset is minted: ${JSON.stringify(replacement).slice(0, 300)}`);
  assert.equal(replacement.reviewStatus, "pending_review", "the replacement is not approved by inheritance");
  const events = sqlite.prepare("SELECT event_type,media_id,detail_json FROM service_media_events WHERE media_id IN (?,?)").all(grant.mediaId, replacement.mediaId);
  assert.ok(events.some((row) => String(row.event_type).includes("replaced")), `the replacement is audited: ${JSON.stringify(events).slice(0, 400)}`);
  const superseded = sqlite.prepare("SELECT retention_status FROM service_media_assets WHERE id=?").get(grant.mediaId);
  assert.notEqual(String(superseded.retention_status), "active", "and the superseded asset is no longer active");
});

test("M04-26: deletion is audited and states the reason", async () => {
  const { boundary, db, sqlite } = await world();
  const grant = await boundary.issueMediaUploadGrant(db, GRANT);
  await boundary.redeemMediaUploadGrant(db, { token: grant.token, objectKey: grant.objectKey, observed: { sizeBytes: 2048, sha256: SHA_A, mimeType: "image/jpeg" }, actorId: UPLOADER });
  const deleted = await boundary.deleteMedia(db, { mediaId: grant.mediaId, actorId: REVIEWER, reason: "The customer asked for the photo to be removed" });
  assert.equal(deleted.retentionStatus, "deleted", `deletion takes effect: ${JSON.stringify(deleted).slice(0, 300)}`);
  const event = sqlite.prepare("SELECT event_type,actor_id,detail_json FROM service_media_events WHERE media_id=? AND event_type LIKE '%deleted%'").get(grant.mediaId);
  assert.ok(event, "the deletion is audited");
  assert.ok(String(event.detail_json).includes("customer asked"), `with the stated reason: ${String(event?.detail_json).slice(0, 200)}`);
});

test("M04-27: deletion without a reason is refused", async () => {
  const { boundary, db } = await world();
  const grant = await boundary.issueMediaUploadGrant(db, GRANT);
  const refused = await attempt(boundary.deleteMedia(db, { mediaId: grant.mediaId, actorId: REVIEWER, reason: "" }));
  assert.equal(refused.ok, false, `an unexplained deletion must be refused: ${JSON.stringify(refused).slice(0, 300)}`);
});

// ---------------------------------------------------------------------------------------------------
// The boundary is a governed business setting, per vertical and per city
// ---------------------------------------------------------------------------------------------------

test("M04-28: a city may narrow the permitted categories without a code change", async () => {
  const { boundary, db } = await world();
  const governance = await import("../lib/service-policy-governance.ts");
  await boundary.issueMediaUploadGrant(db, GRANT);
  await governance.writeServicePolicy(db, {
    domain: boundary.MEDIA_UPLOAD_POLICY_DOMAIN, serviceCode: "grooming", cityId: "blr",
    config: { permittedCategories: ["before_service", "after_service"] },
  }, "founder@pawspace.test", "Bengaluru grooming does not capture issue media in app yet");
  const refused = await attempt(boundary.issueMediaUploadGrant(db, { ...GRANT, category: "service_issue" }));
  assert.equal(refused.ok, false, `the narrowed city policy applies: ${JSON.stringify(refused).slice(0, 300)}`);
  const other = await attempt(boundary.issueMediaUploadGrant(db, { ...GRANT, cityId: "del", category: "service_issue" }));
  assert.equal(other.ok, true, `and does not leak into another city: ${JSON.stringify(other).slice(0, 300)}`);
});

// ---------------------------------------------------------------------------------------------------
// The two routes that were left on the weaker path
// ---------------------------------------------------------------------------------------------------

async function routeWorld() {
  const built = await world();
  const route = await import("../app/api/service-media/route.ts");
  const call = async (method, body, as = STAFF) => {
    const response = await route[method](new Request("https://uat.pawspace.in/api/service-media", { method, headers: as, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { ...built, call };
}

test("M04-29: /api/service-media issues a real upload grant, not storage:not_connected", async () => {
  const { call } = await routeWorld();
  const created = await call("POST", { bookingId: "BK-GROOM-1", purpose: "after_service", mimeType: "image/jpeg", sizeBytes: 2048, sha256: SHA_A, fileName: "after.jpg" });
  assert.equal(created.status, 201, `the request is accepted: ${JSON.stringify(created).slice(0, 300)}`);
  const upload = created.body?.data?.upload;
  assert.ok(upload, `an upload grant is returned: ${JSON.stringify(created.body).slice(0, 400)}`);
  assert.ok(upload.token, "with a token");
  assert.ok(upload.objectKey, "an object key");
  assert.ok(upload.expiresAt > Date.now(), "and an expiry");
});

test("M04-30: /api/service-media will not confirm an upload without a valid grant token", async () => {
  const { call } = await routeWorld();
  const created = await call("POST", { bookingId: "BK-GROOM-1", purpose: "after_service", mimeType: "image/jpeg", sizeBytes: 2048, sha256: SHA_A, fileName: "after.jpg" });
  const id = created.body.data.id;
  const refused = await call("PATCH", { id, action: "confirm_upload", storageReference: "uat/grooming/BK-GROOM-1/after-service-01.jpg" });
  assert.notEqual(refused.status, 200,
    `a storage reference with no upload token must no longer be accepted: ${JSON.stringify(refused).slice(0, 300)}`);
});

test("M04-31: /api/service-media confirms an upload that presents its own grant token", async () => {
  // Non-vacuity for M04-30. Refusing every confirmation would satisfy it and break proof upload.
  const { call } = await routeWorld();
  const created = await call("POST", { bookingId: "BK-GROOM-1", purpose: "after_service", mimeType: "image/jpeg", sizeBytes: 2048, sha256: SHA_A, fileName: "after.jpg" });
  const { id, upload } = created.body.data;
  const confirmed = await call("PATCH", {
    id, action: "confirm_upload", uploadToken: upload.token, storageReference: upload.objectKey,
    observedSizeBytes: 2048, observedSha256: SHA_A, observedMimeType: "image/jpeg",
  });
  assert.equal(confirmed.status, 200, `the legitimate confirmation succeeds: ${JSON.stringify(confirmed).slice(0, 400)}`);
  assert.equal(confirmed.body?.data?.reviewStatus, "pending_review", "and the asset enters PENDING_REVIEW");
});

test("M04-32: /api/training-session-media issues a real upload grant too", async () => {
  const built = await world();
  const { db, sqlite } = built;
  const programme = await import("../lib/training-programme.ts");
  const accounts = await import("../lib/customer-account.ts");
  await programme.ensureTrainingProgrammeTables(db);
  await accounts.ensureCustomerAccountTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT INTO training_programmes (id,booking_id,customer_id,provider_id,city_id,zone_id,plan_code,plan_name,pet_ids_json,requirements_json,total_sessions,completed_sessions,no_show_sessions,cancelled_sessions,status,created_at,updated_at) VALUES ('TP-1','BK-TRAIN-1','CUS-1','PRV-GROOMER-1','blr','blr-east','train-basic','Basic obedience','[\"PET-1\"]','[]',6,0,0,0,'scheduled',?,?)").run(now, now);
  sqlite.prepare("INSERT INTO training_sessions (id,programme_id,booking_id,schedule_reservation_id,sequence_no,provider_id,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES ('TS-1','TP-1','BK-TRAIN-1','RES-1',1,'PRV-GROOMER-1','2026-08-01T09:00:00.000Z','2026-08-01T10:00:00.000Z','accepted',?,?)").run(now, now);
  const route = await import("../app/api/training-session-media/route.ts");
  const response = await route.POST(new Request("https://uat.pawspace.in/api/training-session-media", {
    method: "POST", headers: STAFF,
    body: JSON.stringify({ sessionId: "TS-1", mimeType: "image/jpeg", sizeBytes: 2048, sha256: SHA_A, fileName: "homework.jpg" }),
  }));
  const body = await response.json().catch(() => null);
  assert.equal(response.status, 201, `the request is accepted: ${JSON.stringify(body).slice(0, 400)}`);
  assert.ok(body?.data?.upload?.token, `an upload grant is returned: ${JSON.stringify(body).slice(0, 400)}`);
  assert.ok(body.data.upload.expiresAt > Date.now(), "with an expiry");
});

test("M04-33: an upload token is refused when the actor's provider is not assigned to the booking", async () => {
  // Step 2 of the approved rule, enforced in the authority rather than in one route's prologue.
  const { boundary, db } = await world();
  const refused = await attempt(boundary.issueMediaUploadGrant(db, { ...GRANT, providerId: "PRV-SOMEONE-ELSE" }));
  assert.equal(refused.ok, false, `an unassigned provider must not receive an upload token: ${JSON.stringify(refused).slice(0, 300)}`);
  const missing = await attempt(boundary.issueMediaUploadGrant(db, { ...GRANT, bookingId: "BK-NO-SUCH", scopeId: "BK-NO-SUCH" }));
  assert.equal(missing.ok, false, `and neither must a booking with no work order: ${JSON.stringify(missing).slice(0, 300)}`);
});
