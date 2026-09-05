import assert from "node:assert/strict";
import test from "node:test";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__BOARDING_GATE4_DB__", "__BOARDING_GATE4_ENV__");

async function seedProof() {
  const { sqlite, db } = freshCountingD1();
  const proof = await import("../lib/boarding-proof-governance.ts");
  await proof.ensureBoardingProofTables(db);
  const now = Date.now();
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,schedule_group_id TEXT,status TEXT,provider_id TEXT,service_code TEXT,total_amount REAL,package_name TEXT)");
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-BG4','GRP-BG4','assigned','host_maya_rohan','boarding',699,'Luxury Stay')").run();
  sqlite.prepare("INSERT INTO boarding_stays (id,booking_id,customer_id,host_provider_id,city_id,zone_id,package_code,check_in_at,check_out_at,billed_units,pet_count,status,care_plan_status,check_in_status,check_out_status,extension_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("STAY-BG4","BK-BG4","CUS-BG4","host_maya_rohan","blr","blr-east","boarding-24h",new Date(now+86_400_000).toISOString(),new Date(now+2*86_400_000).toISOString(),1,1,"confirmed","ready","pending","pending","none",now,now);
  return { sqlite, db, proof };
}

async function rejectedResponse(work) {
  try { await work(); assert.fail("expected rejection"); }
  catch (error) { assert.ok(error instanceof Response); return error; }
}

test("Boarding Gate 4 executes private opaque media-grant creation", async () => {
  const { sqlite, db, proof } = await seedProof();
  const result = await proof.mutateBoardingProof(db, {
    stayId: "STAY-BG4", action: "prepare_media", actorId: "host@pawspace.in", idempotencyKey: "bg4-media",
    purpose: "stay_update", mimeType: "image/jpeg", sizeBytes: 5000, sha256: "a".repeat(64),
  });
  assert.equal(result.upload.rawPublicUrl, false);
  assert.equal(result.upload.mode, "sandbox_contract");
  assert.equal(result.proofReady, false);
  const asset = sqlite.prepare("SELECT booking_id,provider_id,scan_status,access_status,synthetic FROM service_media_assets WHERE id=?").get(result.mediaId);
  assert.deepEqual({ ...asset }, { booking_id: "BK-BG4", provider_id: "host_maya_rohan", scan_status: "pending", access_status: "pending_upload", synthetic: 0 });
  const grant = sqlite.prepare("SELECT status,expires_at FROM boarding_media_upload_grants WHERE media_id=?").get(result.mediaId);
  assert.equal(grant.status, "issued");
  assert.ok(Number(grant.expires_at) > Date.now());
});

test("Boarding Gate 4 rejects unsupported media before persisting an asset", async () => {
  const { sqlite, db, proof } = await seedProof();
  const failure = await rejectedResponse(() => proof.mutateBoardingProof(db, {
    stayId: "STAY-BG4", action: "prepare_media", actorId: "host@pawspace.in", idempotencyKey: "bg4-gif",
    purpose: "stay_update", mimeType: "image/gif", sizeBytes: 5000, sha256: "b".repeat(64),
  }));
  assert.equal(failure.status, 400);
  assert.match(await failure.text(), /JPEG, PNG, WebP and MP4/i);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM service_media_assets WHERE booking_id='BK-BG4'").get().n, 0);
});
