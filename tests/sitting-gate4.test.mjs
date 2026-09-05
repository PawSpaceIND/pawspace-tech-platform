/**
 * Pet Sitting Gate 4 — EXECUTED. Media grants, evidence ownership, scan review, medication evidence
 * and incidents.
 *
 * WHAT THIS FILE USED TO BE. Nine tests of regexes over `lib/sitting-proof-governance.ts`, the proof
 * route, the sitter workspace and the customer incident panel.
 *
 * Sitting's evidence rules are NOT Boarding's, and that is the thing a source-text test blurs:
 * Sitting accepts JPEG, PNG and WebP only — no video — while Boarding also takes MP4. Both files say
 * "accepted evidence"; only one of them takes a video.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import {
  freshSqlite, makeD1, refusal, nextKey, seedSittingBooking, validSittingCarePlan,
  seedDoorstep, metresNorth, stayUrl,
} from "./helpers/stay-harness.mjs";

installWorkersHooks("__SITTING_G4_DB__", "__SITTING_G4_ENV__");

const proof = await import("../lib/sitting-proof-governance.ts");
const lifecycle = await import("../lib/sitting-lifecycle.ts");

const SITTER = "sitter_ananya";
const REVIEWER = "ops.reviewer@pawspace.test";
const SHA = "b".repeat(64);
const OBJECT_ID = "sitting/objects/7c4e1ba98f";

const liveWindow = () => ({
  scheduledStart: new Date(Date.now() - 3_600_000).toISOString(),
  scheduledEnd: new Date(Date.now() + 7_200_000).toISOString(),
});

async function proofWorld({ carePlan = validSittingCarePlan(), checkIn = true, ...options } = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__SITTING_G4_DB__ = db;
  globalThis.__SITTING_G4_ENV__ = {};
  const seeded = await seedSittingBooking(db, sqlite, { window: liveWindow(), ...options });
  const doorstep = seedDoorstep(sqlite, { bookingId: seeded.bookingId, customerId: seeded.customerId });
  await proof.ensureSittingProofTables(db);

  const stayAct = (action, extra = {}) => lifecycle.mutateSittingBooking(db, {
    bookingId: seeded.bookingId, action, actorId: extra.actorId ?? SITTER, idempotencyKey: nextKey("SG4-LC"), ...extra,
  });
  await stayAct("accept");
  if (carePlan) await stayAct("submit_care_plan", { carePlan, actorId: seeded.customerId });
  if (checkIn) await stayAct("check_in", { ...metresNorth(doorstep, 20) });

  const act = (action, extra = {}) => proof.mutateSittingProof(db, {
    bookingId: seeded.bookingId, action, actorId: extra.actorId ?? SITTER,
    idempotencyKey: extra.idempotencyKey ?? nextKey("SG4"), ...extra,
  });
  const prepare = (extra = {}) => proof.prepareSittingMedia(db, {
    bookingId: seeded.bookingId, action: "prepare_media", actorId: extra.actorId ?? SITTER,
    idempotencyKey: nextKey("SG4-PREP"), purpose: "sitting_update", mimeType: "image/jpeg",
    sizeBytes: 180_000, sha256: SHA, ...extra,
  });
  return { sqlite, db, ...seeded, doorstep, act, prepare, stayAct };
}

async function cleanAsset(world, extra = {}) {
  const grant = await world.prepare(extra);
  await world.act("sandbox_finalize_media", {
    mediaRef: grant.mediaRef, uploadToken: grant.upload.token,
    storageObjectId: `sitting/objects/${nextKey("O")}`, ...extra,
  });
  await world.act("record_media_scan", { mediaRef: grant.mediaRef, scanResult: "clean", actorId: REVIEWER });
  return grant;
}

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 4 issues a short-lived grant and stores the token's digest, not the token", async () => {
  const world = await proofWorld();
  const before = Date.now();
  const grant = await world.prepare();

  assert.ok(grant.upload.token, "the caller is handed a token");
  const row = await world.db.prepare("SELECT * FROM sitting_media_upload_grants WHERE media_id=?").bind(grant.mediaId).first();
  assert.ok(row.token_hash);
  assert.notEqual(row.token_hash, grant.upload.token, "the raw token must never be what is stored");

  const ttl = Number(row.expires_at) - before;
  assert.ok(ttl > 14 * 60_000 && ttl <= 15 * 60_000 + 5_000, `a grant lives about fifteen minutes, got ${ttl}ms`);

  const asset = await world.db.prepare("SELECT storage_key FROM service_media_assets WHERE id=?").bind(grant.mediaId).first();
  assert.doesNotMatch(String(asset.storage_key), /^https?:/, "the storage key is opaque, not a public URL");
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 4 accepts images only — no video, unlike Boarding", async () => {
  const world = await proofWorld();

  for (const mimeType of ["image/jpeg", "image/png", "image/webp"]) {
    const granted = await world.prepare({ mimeType });
    assert.ok(granted.upload.token, `${mimeType} is accepted Sitting evidence`);
  }

  // Boarding takes MP4. Sitting does not, and the two suites used to assert the same sentence.
  const video = await refusal(world.prepare({ mimeType: "video/mp4" }));
  assert.ok(video, "Sitting proof must refuse video");
  assert.match(video.message, /Only JPEG, PNG and WebP Sitting proof images are accepted/);

  const pdf = await refusal(world.prepare({ mimeType: "application/pdf" }));
  assert.ok(pdf);
  assert.match(pdf.message, /Only JPEG, PNG and WebP/);

  const badChecksum = await refusal(world.prepare({ sha256: "not-a-digest" }));
  assert.equal(badChecksum?.status, 400);
  assert.match(badChecksum.message, /valid SHA-256 checksum is required/);
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 4 confirms storage with an opaque object id and refuses an expired grant", async () => {
  const world = await proofWorld();

  const grant = await world.prepare();
  const publicUrl = await refusal(world.act("sandbox_finalize_media", {
    mediaRef: grant.mediaRef, uploadToken: grant.upload.token, storageObjectId: "https://cdn.example.com/pet.jpg",
  }));
  assert.ok(publicUrl);
  assert.match(publicUrl.message, /opaque object ID, not a public URL|Sandbox upload token and opaque storage object ID are required/);

  const wrongToken = await world.prepare();
  const mismatched = await refusal(world.act("sandbox_finalize_media", {
    mediaRef: wrongToken.mediaRef, uploadToken: "not-the-token", storageObjectId: OBJECT_ID,
  }));
  assert.ok(mismatched, "a wrong token finds no grant");

  const expired = await world.prepare();
  await world.db.prepare("UPDATE sitting_media_upload_grants SET expires_at=? WHERE media_id=?").bind(Date.now() - 1000, expired.mediaId).run();
  const stale = await refusal(world.act("sandbox_finalize_media", {
    mediaRef: expired.mediaRef, uploadToken: expired.upload.token, storageObjectId: OBJECT_ID,
  }));
  assert.equal(stale?.status, 409);
  assert.match(stale.message, /grant expired/);
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 4 will not let one booking's evidence be attached to another", async () => {
  const world = await proofWorld();
  const other = await proofWorld({ bookingId: "BKG-SIT-OTHER", customerId: "CUST-SIT-OTHER" });

  const foreign = await other.prepare();
  const crossBooking = await refusal(world.act("sandbox_finalize_media", {
    mediaRef: foreign.mediaRef, uploadToken: foreign.upload.token, storageObjectId: OBJECT_ID,
  }));
  assert.ok(crossBooking, "evidence from another booking must not finalize here");

  const stillPending = await other.db.prepare("SELECT access_status FROM service_media_assets WHERE id=?").bind(foreign.mediaId).first();
  assert.equal(stillPending.access_status, "pending_upload", "and the other booking's asset is untouched");

  const notAReference = await refusal(world.act("record_update", { mediaRef: "not-a-media-id", note: "morning visit done" }));
  assert.equal(notAReference?.status, 400);
  assert.match(notAReference.message, /PawSpace media reference|Invalid PawSpace media asset reference/);
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 4 keeps scan review away from the sitter who submitted the evidence", async () => {
  const world = await proofWorld();
  const grant = await world.prepare();
  await world.act("sandbox_finalize_media", { mediaRef: grant.mediaRef, uploadToken: grant.upload.token, storageObjectId: OBJECT_ID });

  const selfApproved = await refusal(world.act("record_media_scan", { mediaRef: grant.mediaRef, scanResult: "clean", actorId: SITTER }));
  assert.ok(selfApproved, "the submitter cannot clear their own evidence");

  const nonsense = await refusal(world.act("record_media_scan", { mediaRef: grant.mediaRef, scanResult: "probably_fine", actorId: REVIEWER }));
  assert.equal(nonsense?.status, 400);
  assert.match(nonsense.message, /must be clean or rejected/);

  await world.act("record_media_scan", { mediaRef: grant.mediaRef, scanResult: "clean", actorId: REVIEWER });
  const asset = await world.db.prepare("SELECT scan_status FROM service_media_assets WHERE id=?").bind(grant.mediaId).first();
  assert.equal(asset.scan_status, "clean");
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 4 requires a note on an update and a Care Card for medication", async () => {
  const world = await proofWorld({ carePlan: validSittingCarePlan({ medication: "Amoxicillin 250mg twice daily" }) });

  const evidence = await cleanAsset(world, { purpose: "sitting_update" });
  const noNote = await refusal(world.act("record_update", { mediaRef: evidence.mediaRef, note: "" }));
  assert.equal(noNote?.status, 400);
  assert.match(noNote.message, /A Sitting update note is required/);

  const noted = await world.act("record_update", { mediaRef: evidence.mediaRef, note: "Fed, walked and settled" });
  assert.ok(noted);

  const meds = await cleanAsset(world, { purpose: "sitting_medication" });

  // Medication evidence needs a Care Card that is actually READY. Sabotage caught this missing: the
  // happy-path fixture always has one, so the guard was never exercised in its failing direction.
  // The snapshot is put back to a non-ready state rather than skipping the care plan, because a
  // booking cannot reach in_progress without one.
  await world.db.prepare("UPDATE sitting_care_plan_snapshots SET status='draft' WHERE booking_id=?").bind(world.bookingId).run();
  const notReady = await refusal(world.act("record_medication", {
    mediaRef: meds.mediaRef, medicationName: "Amoxicillin", dose: "250mg", administeredAt: new Date().toISOString(),
  }));
  assert.equal(notReady?.status, 409);
  assert.match(notReady.message, /A ready Care Card is required before medication evidence/);
  await world.db.prepare("UPDATE sitting_care_plan_snapshots SET status='ready' WHERE booking_id=?").bind(world.bookingId).run();

  const incomplete = await refusal(world.act("record_medication", { mediaRef: meds.mediaRef, medicationName: "Amoxicillin" }));
  assert.equal(incomplete?.status, 400);
  assert.match(incomplete.message, /name, dose and administered time are required/);

  const recorded = await world.act("record_medication", {
    mediaRef: meds.mediaRef, medicationName: "Amoxicillin", dose: "250mg", administeredAt: new Date().toISOString(),
  });
  assert.ok(recorded);
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 4 incidents preserve the booking and never move money", async () => {
  const world = await proofWorld();

  const incomplete = await refusal(world.act("report_incident", { severity: "urgent" }));
  assert.equal(incomplete?.status, 400);
  assert.match(incomplete.message, /severity and summary are required/);

  const reported = await world.act("report_incident", {
    severity: "emergency", summary: "pet slipped its collar", actionTaken: "recovered and vet checked",
  });
  assert.ok(reported.incidentId);
  assert.equal(reported.bookingPreserved, true);
  assert.equal(reported.automaticRefund, false, "an incident never becomes a refund on its own");
  assert.equal(reported.automaticPayoutChange, false, "nor a payout change");

  const booking = await world.db.prepare("SELECT status FROM canonical_bookings WHERE id=?").bind(world.bookingId).first();
  assert.equal(booking.status, "in_progress", "and the visit continues");
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 4 keeps incident acknowledgement and resolution away from the reporter", async () => {
  const world = await proofWorld();
  const reported = await world.act("report_incident", {
    severity: "urgent", summary: "limping after the walk", actionTaken: "rested and observed",
  });

  const selfAck = await refusal(world.act("acknowledge_incident", { incidentId: reported.incidentId, actorId: SITTER }));
  assert.ok(selfAck);
  assert.match(selfAck.message, /cannot be acknowledged by the actor who reported it/);

  await world.act("acknowledge_incident", { incidentId: reported.incidentId, actorId: world.customerId });

  const selfResolve = await refusal(world.act("resolve_incident", { incidentId: reported.incidentId, actorId: SITTER, resolution: "fine now" }));
  assert.ok(selfResolve);
  assert.match(selfResolve.message, /cannot be resolved by the actor who reported it/);

  const noNote = await refusal(world.act("resolve_incident", { incidentId: reported.incidentId, actorId: REVIEWER }));
  assert.equal(noNote?.status, 400);
  assert.match(noNote.message, /Incident resolution is required/);

  const resolved = await world.act("resolve_incident", { incidentId: reported.incidentId, actorId: REVIEWER, resolution: "vet cleared the pet" });
  assert.ok(resolved);
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 4 refuses an unknown booking, an unknown action and an incomplete request", async () => {
  const world = await proofWorld();

  const unknown = await refusal(proof.mutateSittingProof(world.db, {
    bookingId: "BKG-NOPE", action: "report_incident", actorId: SITTER, idempotencyKey: nextKey("SG4"),
    severity: "attention", summary: "x",
  }));
  assert.equal(unknown?.status, 404);
  assert.match(unknown.message, /Sitting booking not found/);

  const unsupported = await refusal(world.act("delete_everything"));
  assert.equal(unsupported?.status, 400);
  assert.match(unsupported.message, /Unsupported Sitting proof action/);

  const incomplete = await refusal(proof.mutateSittingProof(world.db, {
    bookingId: world.bookingId, action: "report_incident", actorId: "", idempotencyKey: "",
  }));
  assert.equal(incomplete?.status, 400);
  assert.match(incomplete.message, /actor and idempotency key are required/);
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting proof API is a guarded route", async () => {
  const world = await proofWorld();
  const gateway = await import("../lib/api-gateway.ts");

  const decision = await gateway.authorizeApiRequest(
    new Request(stayUrl("/api/sitting-proof"), { method: "POST", headers: { "content-type": "application/json" } }),
    { DB: world.db },
  );
  if (decision instanceof Response) {
    assert.equal(decision.status, 401, "the gateway refuses an unauthenticated proof action outright");
  } else {
    assert.ok(decision.permission, "a Sitting proof action is never public");
  }

  const route = await import("../app/api/sitting-proof/route.ts");
  const anonymous = await route.POST(new Request(stayUrl("/api/sitting-proof"), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ bookingId: world.bookingId, action: "report_incident", severity: "emergency", summary: "anonymous", actionTaken: "none", idempotencyKey: nextKey("SG4-API") }),
  }));
  assert.ok(anonymous.status === 401 || anonymous.status === 403, `an anonymous incident report is refused: ${anonymous.status}`);
});
