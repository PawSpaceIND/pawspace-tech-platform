import assert from "node:assert/strict";
import test from "node:test";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__SITTING_GATE4_DB__", "__SITTING_GATE4_ENV__");

async function seedProof() {
  const { sqlite, db } = freshCountingD1();
  const proof = await import("../lib/sitting-proof-governance.ts");
  await proof.ensureSittingProofTables(db);
  const now = Date.now();
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,schedule_group_id TEXT,provider_id TEXT,service_code TEXT,status TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT,status TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-SG4','CUS-SG4','GRP-SG4','PRV-SG4','pet_sitting','assigned',?,?)").run(now, now);
  sqlite.prepare("INSERT INTO provider_work_orders VALUES ('WO-SG4','BK-SG4','PRV-SG4','accepted',?,?)").run(now, now);
  return { sqlite, db, proof };
}

async function rejectedResponse(work) {
  try { await work(); assert.fail("expected rejection"); }
  catch (error) { assert.ok(error instanceof Response); return error; }
}

test("Sitting Gate 4 executes private opaque media-grant creation", async () => {
  const { sqlite, db, proof } = await seedProof();
  const result = await proof.mutateSittingProof(db, {
    bookingId: "BK-SG4", action: "prepare_media", actorId: "sitter@pawspace.in", idempotencyKey: "sg4-media",
    purpose: "sitting_update", mimeType: "image/jpeg", sizeBytes: 5000, sha256: "a".repeat(64),
  });
  assert.equal(result.upload.rawPublicUrl, false);
  assert.equal(result.upload.mode, "sandbox_contract");
  assert.equal(result.proofReady, false);
  const asset = sqlite.prepare("SELECT booking_id,provider_id,scan_status,access_status,synthetic FROM service_media_assets WHERE id=?").get(result.mediaId);
  assert.deepEqual(asset, { booking_id: "BK-SG4", provider_id: "PRV-SG4", scan_status: "pending", access_status: "pending_upload", synthetic: 0 });
  const grant = sqlite.prepare("SELECT status,expires_at FROM sitting_media_upload_grants WHERE media_id=?").get(result.mediaId);
  assert.equal(grant.status, "issued");
  assert.ok(Number(grant.expires_at) > Date.now());
});

test("Sitting Gate 4 rejects unsupported media before persisting an asset", async () => {
  const { sqlite, db, proof } = await seedProof();
  const failure = await rejectedResponse(() => proof.mutateSittingProof(db, {
    bookingId: "BK-SG4", action: "prepare_media", actorId: "sitter@pawspace.in", idempotencyKey: "sg4-gif",
    purpose: "sitting_update", mimeType: "image/gif", sizeBytes: 5000, sha256: "b".repeat(64),
  }));
  assert.equal(failure.status, 400);
  assert.match(await failure.text(), /JPEG, PNG and WebP/i);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM service_media_assets WHERE booking_id='BK-SG4'").get().n, 0);
});
