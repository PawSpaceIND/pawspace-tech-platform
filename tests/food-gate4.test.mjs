import test from "node:test";
import assert from "node:assert/strict";
import {
  freshFoodWorld,
  createFoodOrderFixture,
  fulfilTo,
  prepareCleanMedia,
  ensureFoodFinanceTables,
  mutateFoodProof,
  expectResponse,
} from "./helpers/food-gate-harness.mjs";

test("Food Gate 4 executes private short-lived media grants and stores only the token digest", async () => {
  const world = freshFoodWorld();
  const fixture = await createFoodOrderFixture(world, { idempotencyKey: "gate4-media" });
  await fulfilTo(world, fixture, "picked");
  const before = Date.now();
  const prepared = await mutateFoodProof(world.db, {
    orderId: fixture.orderId,
    action: "prepare_media",
    actorId: "media@example.in",
    idempotencyKey: "gate4-prepare",
    purpose: "food_package",
    mimeType: "image/jpeg",
    sizeBytes: 1024,
    sha256: "b".repeat(64),
  });
  assert.equal(prepared.upload.adapterConnected, false);
  assert.equal(prepared.upload.rawPublicUrl, false);
  assert.ok(prepared.upload.expiresAt >= before + 14 * 60_000);
  assert.ok(prepared.upload.expiresAt <= Date.now() + 16 * 60_000);
  const grant = world.sqlite.prepare("SELECT token_hash,expires_at,status FROM food_media_upload_grants WHERE media_id=?").get(prepared.mediaId);
  assert.equal(grant.status, "issued");
  assert.notEqual(grant.token_hash, prepared.upload.token);
  assert.equal(grant.expires_at, prepared.upload.expiresAt);
});

test("Food Gate 4 refuses unsupported MIME, bad checksums, public storage URLs and self-approved scans", async () => {
  const world = freshFoodWorld();
  const fixture = await createFoodOrderFixture(world, { idempotencyKey: "gate4-refuse" });
  await fulfilTo(world, fixture, "picked");
  await expectResponse(mutateFoodProof(world.db, {
    orderId: fixture.orderId,
    action: "prepare_media",
    actorId: "media@example.in",
    idempotencyKey: "gate4-video",
    purpose: "food_package",
    mimeType: "video/mp4",
    sizeBytes: 1024,
    sha256: "c".repeat(64),
  }), 400, /JPEG, PNG and WebP/i);
  await expectResponse(mutateFoodProof(world.db, {
    orderId: fixture.orderId,
    action: "prepare_media",
    actorId: "media@example.in",
    idempotencyKey: "gate4-checksum",
    purpose: "food_package",
    mimeType: "image/jpeg",
    sizeBytes: 1024,
    sha256: "not-a-digest",
  }), 400, /SHA-256/i);

  const prepared = await mutateFoodProof(world.db, {
    orderId: fixture.orderId,
    action: "prepare_media",
    actorId: "media@example.in",
    idempotencyKey: "gate4-good-prepare",
    purpose: "food_package",
    mimeType: "image/jpeg",
    sizeBytes: 1024,
    sha256: "d".repeat(64),
  });
  await expectResponse(mutateFoodProof(world.db, {
    orderId: fixture.orderId,
    action: "sandbox_finalize_media",
    actorId: "media@example.in",
    idempotencyKey: "gate4-public-url",
    uploadToken: prepared.upload.token,
    storageObjectId: "https://cdn.example/food.jpg",
  }), 400, /opaque object ID/i);

  await mutateFoodProof(world.db, {
    orderId: fixture.orderId,
    action: "sandbox_finalize_media",
    actorId: "media@example.in",
    idempotencyKey: "gate4-finalize",
    uploadToken: prepared.upload.token,
    storageObjectId: `private/${fixture.orderId}/food-package.jpg`,
  });
  await expectResponse(mutateFoodProof(world.db, {
    orderId: fixture.orderId,
    action: "record_media_scan",
    actorId: "media@example.in",
    idempotencyKey: "gate4-self-scan",
    mediaRef: prepared.mediaRef,
    scanResult: "clean",
  }), 403, /cannot be scan-approved by the actor who submitted/i);
});

test("Food Gate 4 records clean package proof and enforces order ownership", async () => {
  const world = freshFoodWorld();
  const first = await createFoodOrderFixture(world, { idempotencyKey: "gate4-proof-1" });
  await fulfilTo(world, first, "packed");
  const media = await prepareCleanMedia(world, first, { purpose: "food_package" });
  const recorded = await mutateFoodProof(world.db, {
    orderId: first.orderId,
    action: "record_package_proof",
    actorId: "ops@example.in",
    idempotencyKey: "gate4-record-package",
    mediaRef: media.mediaRef,
    note: "Package sealed and lot checked",
  });
  assert.equal(recorded.status, "recorded");
  assert.equal(recorded.productionLotVerified, false);

  const second = await createFoodOrderFixture(world, { idempotencyKey: "gate4-proof-2" });
  await fulfilTo(world, second, "packed");
  await expectResponse(mutateFoodProof(world.db, {
    orderId: second.orderId,
    action: "record_package_proof",
    actorId: "ops@example.in",
    idempotencyKey: "gate4-cross-order",
    mediaRef: media.mediaRef,
    note: "Wrong order asset",
  }), 403, /ownership does not match/i);
});

test("Food Gate 4 quality incidents preserve the order and never mutate money automatically", async () => {
  const world = freshFoodWorld();
  const fixture = await createFoodOrderFixture(world, { idempotencyKey: "gate4-incident" });
  await fulfilTo(world, fixture, "picked");
  await ensureFoodFinanceTables(world.db);
  const incident = await mutateFoodProof(world.db, {
    orderId: fixture.orderId,
    action: "report_quality_incident",
    actorId: "ops@example.in",
    idempotencyKey: "gate4-report-incident",
    severity: "critical",
    summary: "Package seal appears damaged",
    actionTaken: "Isolated package for review",
  });
  assert.equal(incident.status, "ops_escalation");
  assert.equal(incident.orderPreserved, true);
  assert.equal(incident.automaticRefund, false);
  assert.equal(incident.automaticSupplierSettlementChange, false);
  assert.equal(world.sqlite.prepare("SELECT status FROM food_orders WHERE id=?").get(fixture.orderId).status, "picked");
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) count FROM food_refund_ledger WHERE order_id=?").get(fixture.orderId).count, 0);
});
