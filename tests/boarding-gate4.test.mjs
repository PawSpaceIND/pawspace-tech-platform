/**
 * Boarding Gate 4 — EXECUTED. Media upload grants, evidence ownership, scan review, medication
 * evidence and incidents.
 *
 * WHAT THIS FILE USED TO BE. Nine tests, each a block of regexes over
 * `lib/boarding-proof-governance.ts`. "Boarding Gate 4 media grants are short lived opaque and
 * private" asserted that the token `15*60_000` appeared in the file and that the word `token_hash`
 * did. Neither says a grant expires, and neither says the token is not what gets stored.
 *
 * Every test below drives the real `prepareBoardingMedia` / `mutateBoardingProof` against a real
 * SQLite-backed D1 and reads the asset, grant and incident rows back.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1, refusal, nextKey, seedBoardingStay, validCarePlan, stayUrl } from "./helpers/stay-harness.mjs";

installWorkersHooks("__BOARDING_G4_DB__", "__BOARDING_G4_ENV__");

const proof = await import("../lib/boarding-proof-governance.ts");
const lifecycle = await import("../lib/boarding-stay-lifecycle.ts");

const HOST = "host_maya_rohan";
const REVIEWER = "ops.reviewer@pawspace.test";
const SHA = "a".repeat(64);
// A storage object id the validator accepts: opaque, no scheme, at least eight characters.
const OBJECT_ID = "boarding/objects/9f2c1ab47e";

const liveWindow = () => ({
  scheduledStart: new Date(Date.now() - 3_600_000).toISOString(),
  scheduledEnd: new Date(Date.now() + 7_200_000).toISOString(),
});

/** A stay driven all the way to in_progress, which is the state most proof actions require. */
async function proofWorld({ carePlan = validCarePlan(), checkIn = true, ...options } = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__BOARDING_G4_DB__ = db;
  globalThis.__BOARDING_G4_ENV__ = {};
  const seeded = await seedBoardingStay(db, sqlite, { window: liveWindow(), ...options });
  await proof.ensureBoardingProofTables(db);

  const stayAct = (action, extra = {}) => lifecycle.mutateBoardingStay(db, {
    stayId: seeded.stayId, action, actorId: extra.actorId ?? HOST, idempotencyKey: nextKey("G4-STAY"), ...extra,
  });
  await stayAct("accept");
  if (carePlan) await stayAct("submit_care_plan", { carePlan, actorId: seeded.customerId });
  if (checkIn) await stayAct("check_in");

  const act = (action, extra = {}) => proof.mutateBoardingProof(db, {
    stayId: seeded.stayId, action, actorId: extra.actorId ?? HOST,
    idempotencyKey: extra.idempotencyKey ?? nextKey("G4"), ...extra,
  });
  const prepare = (extra = {}) => proof.prepareBoardingMedia(db, {
    stayId: seeded.stayId, action: "prepare_media", actorId: extra.actorId ?? HOST,
    idempotencyKey: nextKey("G4-PREP"), purpose: "stay_update", mimeType: "image/jpeg",
    sizeBytes: 240_000, sha256: SHA, ...extra,
  });
  return { sqlite, db, ...seeded, act, prepare, stayAct };
}

/** Prepare + finalize + clean scan: an asset that is genuinely usable as evidence. */
async function cleanAsset(world, extra = {}) {
  const grant = await world.prepare(extra);
  await world.act("sandbox_finalize_media", {
    mediaRef: grant.mediaRef, uploadToken: grant.upload.token,
    storageObjectId: `boarding/objects/${nextKey("O")}`, ...extra,
  });
  await world.act("record_media_scan", { mediaRef: grant.mediaRef, scanResult: "clean", actorId: REVIEWER });
  return grant;
}

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 4 issues a short-lived grant and stores the token's digest, not the token", async () => {
  const world = await proofWorld();
  const before = Date.now();
  const grant = await world.prepare();

  assert.ok(grant.upload.token, "the caller is handed a token");
  const mediaRef = grant.mediaRef;
  const row = await world.db.prepare("SELECT * FROM boarding_media_upload_grants WHERE media_id=?").bind(grant.mediaId).first();

  // The stored digest must not be the token. Storing the token means a database read is an upload.
  assert.ok(row.token_hash, "the grant stores a digest");
  assert.notEqual(row.token_hash, grant.upload.token, "the raw token must never be what is stored");

  const ttl = Number(row.expires_at) - before;
  assert.ok(ttl > 14 * 60_000 && ttl <= 15 * 60_000 + 5_000, `a grant lives about fifteen minutes, got ${ttl}ms`);

  // The storage key is opaque and namespaced to the booking, not a public URL.
  const asset = await world.db.prepare("SELECT storage_key,scan_status,access_status FROM service_media_assets WHERE id=?").bind(grant.mediaId).first();
  assert.match(String(asset.storage_key), /^boarding\/pending\//);
  assert.doesNotMatch(String(asset.storage_key), /^https?:/);
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 4 refuses an expired grant and a mismatched token", async () => {
  const world = await proofWorld();

  const wrongToken = await world.prepare();
  const wrongRef = wrongToken.mediaRef;
  const mismatched = await refusal(world.act("sandbox_finalize_media", {
    mediaRef: wrongRef, uploadToken: "not-the-token", storageObjectId: OBJECT_ID,
  }));
  assert.equal(mismatched?.status, 409);
  // The grant is looked up BY its token digest, so a wrong token does not find a grant at all. That
  // is a stronger shape than comparing a stored token: there is nothing to compare against.
  assert.match(mismatched.message, /grant is invalid or already consumed/);

  const expired = await world.prepare();
  const expiredRef = expired.mediaRef;
  await world.db.prepare("UPDATE boarding_media_upload_grants SET expires_at=? WHERE media_id=?").bind(Date.now() - 1000, expired.mediaId).run();
  const stale = await refusal(world.act("sandbox_finalize_media", {
    mediaRef: expiredRef, uploadToken: expired.upload.token, storageObjectId: OBJECT_ID,
  }));
  assert.equal(stale?.status, 409);
  assert.match(stale.message, /grant expired/);
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 4 confirms storage with an opaque object id, never a public URL", async () => {
  const world = await proofWorld();
  const grant = await world.prepare();
  const mediaRef = grant.mediaRef;

  const publicUrl = await refusal(world.act("sandbox_finalize_media", {
    mediaRef, uploadToken: grant.upload.token, storageObjectId: "https://cdn.example.com/pet.jpg",
  }));
  assert.equal(publicUrl?.status, 400);
  assert.match(publicUrl.message, /opaque object ID, not a public URL/);

  const missing = await refusal(world.act("sandbox_finalize_media", { mediaRef, uploadToken: grant.upload.token }));
  assert.equal(missing?.status, 400);
  assert.match(missing.message, /upload token and opaque storage object ID are required/);
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 4 enforces MIME, size and checksum before a byte is accepted", async () => {
  const world = await proofWorld();

  const badMime = await refusal(world.prepare({ mimeType: "application/pdf" }));
  assert.equal(badMime?.status, 400);
  assert.match(badMime.message, /JPEG, PNG, WebP and MP4/);

  const badChecksum = await refusal(world.prepare({ sha256: "not-a-digest" }));
  assert.equal(badChecksum?.status, 400);
  assert.match(badChecksum.message, /valid SHA-256 checksum is required/);

  const tooLarge = await refusal(world.prepare({ sizeBytes: 10_000_001 }));
  assert.ok(tooLarge, "an oversized upload is refused before it is granted");

  const badPurpose = await refusal(world.prepare({ purpose: "marketing_shoot" }));
  assert.equal(badPurpose?.status, 400);
  assert.match(badPurpose.message, /Unsupported Boarding media purpose/);

  for (const mimeType of ["image/jpeg", "image/png", "image/webp", "video/mp4"]) {
    const granted = await world.prepare({ mimeType });
    assert.ok(granted.upload.token, `${mimeType} is accepted Boarding evidence`);
  }
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 4 will not let one stay's evidence be attached to another", async () => {
  const world = await proofWorld();
  const other = await proofWorld({ bookingId: "BKG-BOARD-OTHER", customerId: "CUST-OTHER" });

  const foreign = await other.prepare();
  const foreignRef = foreign.mediaRef;

  // The asset exists, but it belongs to the other booking.
  const crossBooking = await refusal(world.act("sandbox_finalize_media", {
    mediaRef: foreignRef, uploadToken: foreign.upload.token, storageObjectId: OBJECT_ID,
  }));
  assert.ok(crossBooking, "evidence from another stay must not finalize here");
  // The grant is scoped to its own stay, so the other stay's token resolves to nothing here.
  assert.match(crossBooking.message, /grant is invalid or already consumed/);
  const stillPending = await other.db.prepare("SELECT access_status FROM service_media_assets WHERE id=?").bind(foreign.mediaId).first();
  assert.equal(stillPending.access_status, "pending_upload", "and the other stay's asset is untouched");

  // The media reference parser is exercised on an action that reaches it: finalize resolves the
  // GRANT first, so a bogus reference there is refused as a missing grant before the parser runs.
  const notAReference = await refusal(world.act("record_daily_update", { mediaRef: "not-a-media-id", note: "morning walk" }));
  assert.equal(notAReference?.status, 400);
  assert.match(notAReference.message, /must use a PawSpace media reference/);

  const malformedReference = await refusal(world.act("record_daily_update", { mediaRef: "media://asset/has/a/path", note: "morning walk" }));
  assert.equal(malformedReference?.status, 400);
  assert.match(malformedReference.message, /Invalid PawSpace media asset reference/);
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 4 keeps scan review out of the hands of the host who submitted it", async () => {
  const world = await proofWorld();
  const grant = await world.prepare();
  const mediaRef = grant.mediaRef;
  await world.act("sandbox_finalize_media", { mediaRef, uploadToken: grant.upload.token, storageObjectId: OBJECT_ID });

  const selfApproved = await refusal(world.act("record_media_scan", { mediaRef, scanResult: "clean", actorId: HOST }));
  assert.equal(selfApproved?.status, 403);
  assert.match(selfApproved.message, /cannot be scan-approved by the actor who submitted it/);

  const nonsense = await refusal(world.act("record_media_scan", { mediaRef, scanResult: "probably_fine", actorId: REVIEWER }));
  assert.equal(nonsense?.status, 400);
  assert.match(nonsense.message, /must be clean or rejected/);

  const reviewed = await world.act("record_media_scan", { mediaRef, scanResult: "clean", actorId: REVIEWER });
  assert.ok(reviewed);
  const asset = await world.db.prepare("SELECT scan_status FROM service_media_assets WHERE id=?").bind(grant.mediaId).first();
  assert.equal(asset.scan_status, "clean");
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 4 requires a ready Care Card carrying a medication instruction", async () => {
  // A care plan with NO medication instruction: the stay is ready, but there is nothing to evidence.
  const noMeds = await proofWorld({ carePlan: validCarePlan({ medication: "" }) });
  const noMedsEvidence = await cleanAsset(noMeds, { purpose: "boarding_medication" });
  const missingInstruction = await refusal(noMeds.act("record_medication", {
    mediaRef: noMedsEvidence.mediaRef,
    medicationName: "Amoxicillin", dose: "250mg", administeredAt: new Date().toISOString(),
  }));
  assert.ok(missingInstruction);
  assert.match(missingInstruction.message, /no medication instruction|ready Care Card is required/);

  const withMeds = await proofWorld({
    bookingId: "BKG-BOARD-MEDS",
    carePlan: validCarePlan({ medication: "Amoxicillin 250mg twice daily" }),
  });
  const evidence = await cleanAsset(withMeds, { purpose: "boarding_medication" });
  const incomplete = await refusal(withMeds.act("record_medication", { mediaRef: evidence.mediaRef, medicationName: "Amoxicillin" }));
  assert.equal(incomplete?.status, 400);
  assert.match(incomplete.message, /name, dose and a valid administration time are required/);

  const recorded = await withMeds.act("record_medication", {
    mediaRef: evidence.mediaRef,
    medicationName: "Amoxicillin", dose: "250mg", administeredAt: new Date().toISOString(),
  });
  assert.ok(recorded);
  const rows = await withMeds.db.prepare("SELECT COUNT(*) n FROM boarding_medication_administrations WHERE stay_id=?").bind(withMeds.stayId).all();
  assert.equal(Number(rows.results[0].n), 1);
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 4 incidents preserve the booking and never move money", async () => {
  const world = await proofWorld();

  const incomplete = await refusal(world.act("report_incident", { severity: "urgent" }));
  assert.equal(incomplete?.status, 400);
  assert.match(incomplete.message, /severity and summary are required/);

  const noAction = await refusal(world.act("report_incident", { severity: "emergency", summary: "pet escaped the garden" }));
  assert.equal(noAction?.status, 400);
  assert.match(noAction.message, /require the action already taken/);

  const reported = await world.act("report_incident", {
    severity: "emergency", summary: "pet escaped the garden", actionTaken: "recovered within 5 minutes, vet checked",
  });
  assert.ok(reported.incidentId);

  const booking = await world.db.prepare("SELECT status FROM canonical_bookings WHERE id=?").bind(world.bookingId).first();
  assert.notEqual(booking.status, "cancelled", "an incident is not a cancellation");

  // The gate's whole point: an incident never becomes a refund or a payout change on its own.
  const refunds = await world.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='boarding_refund_ledger'").first();
  if (refunds) {
    const moved = await world.db.prepare("SELECT COUNT(*) n FROM boarding_refund_ledger WHERE booking_id=?").bind(world.bookingId).all();
    assert.equal(Number(moved.results[0].n), 0, "reporting an incident must not create a refund");
  }
  const incident = await world.db.prepare("SELECT * FROM boarding_incidents WHERE id=?").bind(reported.incidentId).first();
  assert.equal(incident.severity, "emergency");
  assert.equal(incident.notification_status, "queued", "communications are queued, never delivered live in UAT");
  // EQUIVALENT MUTATION, recorded: changing the DDL DEFAULT for notification_status survives, because
  // the INSERT names the column explicitly and the default is unreachable. Mutating the INSERT to
  // write 'sent' instead does turn this assertion red, which is checked.
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 4 keeps incident acknowledgement and resolution away from the reporter", async () => {
  const world = await proofWorld();
  const reported = await world.act("report_incident", {
    severity: "urgent", summary: "limping after the walk", actionTaken: "rested and observed",
  });

  const selfAck = await refusal(world.act("acknowledge_incident", { incidentId: reported.incidentId, actorId: HOST }));
  assert.equal(selfAck?.status, 403);
  assert.match(selfAck.message, /cannot be acknowledged by the actor who reported it/);

  const acknowledged = await world.act("acknowledge_incident", { incidentId: reported.incidentId, actorId: world.customerId });
  assert.ok(acknowledged);

  const selfResolve = await refusal(world.act("resolve_incident", { incidentId: reported.incidentId, actorId: HOST, resolution: "all fine now" }));
  assert.equal(selfResolve?.status, 403);
  assert.match(selfResolve.message, /cannot be resolved by the actor who reported it/);

  const noNote = await refusal(world.act("resolve_incident", { incidentId: reported.incidentId, actorId: REVIEWER }));
  assert.equal(noNote?.status, 400);
  assert.match(noNote.message, /resolution note is required/);

  const resolved = await world.act("resolve_incident", { incidentId: reported.incidentId, actorId: REVIEWER, resolution: "vet cleared the pet" });
  assert.ok(resolved);

  const again = await refusal(world.act("resolve_incident", { incidentId: reported.incidentId, actorId: REVIEWER, resolution: "again" }));
  assert.equal(again?.status, 409);
  assert.match(again.message, /already resolved/);
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 4 refuses an unknown stay, an unknown action and an incomplete request", async () => {
  const world = await proofWorld();

  const unknownStay = await refusal(proof.mutateBoardingProof(world.db, {
    stayId: "BSTAY-NOPE", action: "report_incident", actorId: HOST, idempotencyKey: nextKey("G4"),
    severity: "attention", summary: "x",
  }));
  assert.equal(unknownStay?.status, 404);
  assert.match(unknownStay.message, /Boarding stay not found/);

  const unknownAction = await refusal(world.act("delete_everything"));
  assert.equal(unknownAction?.status, 400);
  assert.match(unknownAction.message, /Unsupported Boarding proof action/);

  const incomplete = await refusal(proof.mutateBoardingProof(world.db, {
    stayId: world.stayId, action: "report_incident", actorId: "", idempotencyKey: "",
  }));
  assert.equal(incomplete?.status, 400);
  assert.match(incomplete.message, /actor and idempotency key are required/);
});

// ---------------------------------------------------------------------------------------------
test("Boarding proof API is a guarded route with separated authority", async () => {
  const world = await proofWorld();
  const gateway = await import("../lib/api-gateway.ts");

  const decision = await gateway.authorizeApiRequest(
    new Request(stayUrl("/api/boarding-proof"), { method: "POST", headers: { "content-type": "application/json" } }),
    { DB: world.db },
  );
  if (decision instanceof Response) {
    assert.equal(decision.status, 401, "the gateway refuses an unauthenticated proof action outright");
  } else {
    assert.ok(decision.permission, "a Boarding proof action is never public");
  }

  const route = await import("../app/api/boarding-proof/route.ts");
  const anonymous = await route.POST(new Request(stayUrl("/api/boarding-proof"), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ stayId: world.stayId, action: "report_incident", severity: "emergency", summary: "anonymous", actionTaken: "none", idempotencyKey: nextKey("G4-API") }),
  }));
  assert.ok(anonymous.status === 401 || anonymous.status === 403, `an anonymous incident report is refused: ${anonymous.status}`);
  const incidents = await world.db.prepare("SELECT COUNT(*) n FROM boarding_incidents WHERE stay_id=?").bind(world.stayId).all();
  assert.equal(Number(incidents.results[0].n), 0, "a refused request must not have written an incident");
});
