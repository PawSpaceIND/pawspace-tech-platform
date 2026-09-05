/**
 * Dog Walking Gate 4 — EXECUTED. Media upload grants, scan review, route evidence and incidents.
 *
 * WHAT THIS FILE USED TO BE. Seven tests, every assertion a regex over the source of
 * `lib/walking-proof-governance.ts`, the route and the provider workspace. "media grants are private
 * short-lived and session-bound" asserted the string `walking_media_upload_grants` appeared in the
 * file. It appears whether the grant expires in fifteen minutes or never, and whether or not anything
 * checks which session it belongs to.
 *
 * Each test below drives the real `mutateWalkingProof` against a real SQLite-backed D1 and asserts on
 * the media, event and incident rows it wrote.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import {
  freshSqlite, makeD1, nextKey, refusal, seedActiveCommercialTerm, seedDoorstep, seedWalkingBooking,
} from "./helpers/stay-harness.mjs";

installWorkersHooks("__WALK_G4_DB__", "__WALK_G4_ENV__");

const lifecycle = await import("../lib/walking-lifecycle.ts");
const proof = await import("../lib/walking-proof-governance.ts");

const DOORSTEP = { latitude: 12.9611, longitude: 77.6387 };
const WALKER = "walker_dev";
const REVIEWER = "trust.reviewer@pawspace.test";
const CUSTOMER = "CUST-WALK-1";
const SHA = "a".repeat(64);

/** Seed a Walking booking and take its first session to in_progress, so proof capture is open. */
async function proofWorld(options = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__WALK_G4_DB__ = db;
  globalThis.__WALK_G4_ENV__ = {};
  await seedActiveCommercialTerm(db, { serviceCode: "dog_walking" });
  const booking = await seedWalkingBooking(db, sqlite, options);
  seedDoorstep(sqlite, {
    bookingId: booking.bookingId, customerId: booking.customerId, providerId: booking.providerId, ...DOORSTEP,
  });
  const act = (action, extra) => lifecycle.mutateWalkingBooking(db, {
    bookingId: booking.bookingId, action, actorId: booking.providerId, idempotencyKey: nextKey(), ...extra,
  });
  await act("accept");
  await act("confirm_handover", { sessionId: booking.sessionId, handoverMethod: "owner" });
  await act("start_walk", { sessionId: booking.sessionId, ...DOORSTEP });
  return { sqlite, db, booking };
}

const capture = (db, booking, action, extra = {}) => proof.mutateWalkingProof(db, {
  bookingId: booking.bookingId, action, actorId: WALKER, idempotencyKey: nextKey(),
  sessionId: booking.sessionId, ...extra,
});

/** A grant → upload → clean-scan cycle, returning a proof asset ready to be attached. */
async function cleanProof(db, booking, { purpose = "walking_update", sessionId = booking.sessionId } = {}) {
  const grant = await capture(db, booking, "prepare_media", {
    sessionId, purpose, mimeType: "image/jpeg", sizeBytes: 120_000, sha256: SHA,
  });
  await capture(db, booking, "sandbox_finalize_media", {
    uploadToken: grant.upload.token, storageObjectId: `walking-object-${grant.mediaId}`,
  });
  await proof.mutateWalkingProof(db, {
    bookingId: booking.bookingId, action: "record_media_scan", actorId: REVIEWER,
    idempotencyKey: nextKey(), mediaRef: grant.mediaRef, scanResult: "clean",
  });
  return grant;
}

// ---------------------------------------------------------------------------------------------
test("Dog Walking Gate 4 media grants are private, short-lived and session-bound", async () => {
  const { db, booking } = await proofWorld({ bookingId: "BKG-WALK-MEDIA", walkCount: 2 });

  const grant = await capture(db, booking, "prepare_media", {
    purpose: "walking_update", mimeType: "image/jpeg", sizeBytes: 120_000, sha256: SHA,
  });
  assert.match(grant.mediaRef, /^media:\/\/asset\/WMEDIA-/, "proof is addressed by an opaque PawSpace reference");
  assert.equal(grant.proofReady, false, "a grant is not proof");
  assert.equal(grant.upload.adapterConnected, false, "the sandbox never claims a connected storage adapter");
  assert.equal(grant.upload.rawPublicUrl, false);
  assert.ok(grant.upload.expiresAt - Date.now() <= 15 * 60_000, "a grant is short-lived");
  assert.ok(grant.upload.expiresAt > Date.now());

  // The token is never stored; only its digest is.
  const stored = await db.prepare("SELECT token_hash,status,session_id,provider_id FROM walking_media_upload_grants WHERE media_id=?").bind(grant.mediaId).first();
  assert.equal(stored.status, "issued");
  assert.equal(stored.session_id, booking.sessionId, "the grant is bound to the session it was issued for");
  assert.equal(stored.provider_id, booking.providerId);
  assert.notEqual(stored.token_hash, grant.upload.token, "the raw upload token is never persisted");
  assert.match(stored.token_hash, /^[a-f0-9]{64}$/);

  // The asset starts unusable: nothing uploaded, nothing scanned.
  const asset = await db.prepare("SELECT scan_status,access_status,retention_status,synthetic,storage_key FROM service_media_assets WHERE id=?").bind(grant.mediaId).first();
  assert.equal(asset.scan_status, "pending");
  assert.equal(asset.access_status, "pending_upload");
  assert.equal(Number(asset.synthetic), 0);
  assert.doesNotMatch(asset.storage_key, /https?:/, "no public URL is stored");

  // A finalize must present the real token, and the object ID must be opaque.
  const publicUrl = await refusal(capture(db, booking, "sandbox_finalize_media", {
    uploadToken: grant.upload.token, storageObjectId: "https://cdn.example.com/walk.jpg",
  }));
  assert.equal(publicUrl?.status, 400);
  assert.match(publicUrl.message, /opaque object ID, not a public URL/);

  const forged = await refusal(capture(db, booking, "sandbox_finalize_media", {
    uploadToken: `${grant.upload.token.split(".")[0]}.deadbeef`, storageObjectId: "walking-object-forged",
  }));
  assert.equal(forged?.status, 403);
  assert.match(forged.message, /upload token mismatch/);

  const finalized = await capture(db, booking, "sandbox_finalize_media", {
    uploadToken: grant.upload.token, storageObjectId: "walking-object-1",
  });
  assert.equal(finalized.status, "quarantined", "an uploaded object is quarantined, not trusted");
  assert.equal(finalized.proofReady, false);

  // The grant is single use.
  const reused = await refusal(capture(db, booking, "sandbox_finalize_media", {
    uploadToken: grant.upload.token, storageObjectId: "walking-object-2",
  }));
  assert.equal(reused?.status, 409);
  assert.match(reused.message, /grant is invalid or already consumed/);

  // An expired grant cannot be finalized at all.
  const stale = await capture(db, booking, "prepare_media", {
    purpose: "walking_update", mimeType: "image/png", sizeBytes: 5_000, sha256: SHA,
  });
  await db.prepare("UPDATE walking_media_upload_grants SET expires_at=? WHERE media_id=?").bind(Date.now() - 1000, stale.mediaId).run();
  const expired = await refusal(capture(db, booking, "sandbox_finalize_media", {
    uploadToken: stale.upload.token, storageObjectId: "walking-object-stale",
  }));
  assert.equal(expired?.status, 409);
  assert.match(expired.message, /grant expired/);
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking Gate 4 enforces MIME, size, checksum and an open session before a grant", async () => {
  const { db, booking } = await proofWorld({ bookingId: "BKG-WALK-MIME" });
  const prepare = (extra) => refusal(capture(db, booking, "prepare_media", {
    purpose: "walking_update", mimeType: "image/jpeg", sizeBytes: 120_000, sha256: SHA, ...extra,
  }));

  for (const mimeType of ["image/gif", "video/mp4", "application/pdf", "text/html"]) {
    const refused = await prepare({ mimeType });
    assert.equal(refused?.status, 400);
    assert.match(refused.message, /Only JPEG, PNG and WebP/);
  }
  for (const mimeType of ["image/jpeg", "image/png", "image/webp"]) {
    const ok = await capture(db, booking, "prepare_media", { purpose: "walking_update", mimeType, sizeBytes: 1000, sha256: SHA });
    assert.ok(ok.mediaId);
  }

  const empty = await prepare({ sizeBytes: 0 });
  assert.match(empty.message, /between 1 byte and 10 MB/);
  const huge = await prepare({ sizeBytes: 10_000_001 });
  assert.match(huge.message, /between 1 byte and 10 MB/);

  for (const sha256 of ["", "nothex", "a".repeat(63), "z".repeat(64)]) {
    const bad = await prepare({ sha256 });
    assert.equal(bad?.status, 400);
    assert.match(bad.message, /valid SHA-256 checksum is required/);
  }

  const wrongPurpose = await prepare({ purpose: "boarding_update" });
  assert.equal(wrongPurpose?.status, 400);
  assert.match(wrongPurpose.message, /Unsupported Dog Walking media purpose/);

  // A session that is not open for capture cannot be granted an upload at all.
  await db.prepare("UPDATE walking_sessions SET status='completed' WHERE id=?").bind(booking.sessionId).run();
  const closed = await prepare({});
  assert.equal(closed?.status, 409);
  assert.match(closed.message, /session is not open for proof capture/);
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking Gate 4 scan review is a separate pair of hands and gates proof", async () => {
  const { db, booking } = await proofWorld({ bookingId: "BKG-WALK-SCAN" });
  const grant = await capture(db, booking, "prepare_media", {
    purpose: "walking_update", mimeType: "image/jpeg", sizeBytes: 90_000, sha256: SHA,
  });
  await capture(db, booking, "sandbox_finalize_media", {
    uploadToken: grant.upload.token, storageObjectId: "walking-object-scan",
  });

  // The uploader cannot clear their own proof.
  const selfApproved = await refusal(proof.mutateWalkingProof(db, {
    bookingId: booking.bookingId, action: "record_media_scan", actorId: WALKER,
    idempotencyKey: nextKey(), mediaRef: grant.mediaRef, scanResult: "clean",
  }));
  assert.equal(selfApproved?.status, 403);
  assert.match(selfApproved.message, /cannot be scan-approved by the actor who submitted it/);

  const invented = await refusal(proof.mutateWalkingProof(db, {
    bookingId: booking.bookingId, action: "record_media_scan", actorId: REVIEWER,
    idempotencyKey: nextKey(), mediaRef: grant.mediaRef, scanResult: "probably_fine",
  }));
  assert.equal(invented?.status, 400);
  assert.match(invented.message, /scan result must be clean or rejected/);

  // A quarantined, unscanned asset is not usable as proof.
  const tooEarly = await refusal(capture(db, booking, "record_photo_update", { mediaRef: grant.mediaRef, note: "Halfway round the park" }));
  assert.equal(tooEarly?.status, 409);
  assert.match(tooEarly.message, /not clean private active proof/);

  const scanned = await proof.mutateWalkingProof(db, {
    bookingId: booking.bookingId, action: "record_media_scan", actorId: REVIEWER,
    idempotencyKey: nextKey(), mediaRef: grant.mediaRef, scanResult: "clean",
  });
  assert.equal(scanned.proofReady, true);
  assert.equal(scanned.accessStatus, "ready");

  const attached = await capture(db, booking, "record_photo_update", { mediaRef: grant.mediaRef, note: "Halfway round the park" });
  assert.equal(attached.mediaRef, grant.mediaRef);
  const note = await db.prepare("SELECT detail_json FROM walking_session_events WHERE booking_id=? AND event_type='proof_photo_update'").bind(booking.bookingId).first();
  assert.equal(JSON.parse(note.detail_json).note, "Halfway round the park");

  const noNote = await refusal(capture(db, booking, "record_photo_update", { mediaRef: grant.mediaRef, note: "ok" }));
  assert.equal(noNote?.status, 400);
  assert.match(noNote.message, /photo update note is required/);

  // A rejected scan leaves the asset quarantined and unusable.
  const bad = await capture(db, booking, "prepare_media", { purpose: "walking_update", mimeType: "image/png", sizeBytes: 4000, sha256: SHA });
  await capture(db, booking, "sandbox_finalize_media", { uploadToken: bad.upload.token, storageObjectId: "walking-object-bad" });
  const rejected = await proof.mutateWalkingProof(db, {
    bookingId: booking.bookingId, action: "record_media_scan", actorId: REVIEWER,
    idempotencyKey: nextKey(), mediaRef: bad.mediaRef, scanResult: "rejected", reason: "Malware signature",
  });
  assert.equal(rejected.proofReady, false);
  assert.equal(rejected.accessStatus, "quarantined");
  const stillRefused = await refusal(capture(db, booking, "record_photo_update", { mediaRef: bad.mediaRef, note: "Trying anyway" }));
  assert.match(stillRefused.message, /not clean private active proof/);

  // Revoking a clean asset takes it back out of service.
  await proof.mutateWalkingProof(db, {
    bookingId: booking.bookingId, action: "revoke_media", actorId: REVIEWER,
    idempotencyKey: nextKey(), mediaRef: grant.mediaRef, reason: "Customer requested removal",
  });
  const afterRevoke = await refusal(capture(db, booking, "record_photo_update", { mediaRef: grant.mediaRef, note: "After revocation" }));
  assert.equal(afterRevoke?.status, 409);
  assert.match(afterRevoke.message, /not clean private active proof/);
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking proof cannot be borrowed across sessions, bookings or evidence slots", async () => {
  const { db, booking } = await proofWorld({ bookingId: "BKG-WALK-BORROW", walkCount: 2 });
  const other = booking.sessions[1].sessionId;

  // Clean proof captured for THIS session cannot be attached to a different one.
  const mine = await cleanProof(db, booking);
  await db.prepare("UPDATE walking_sessions SET status='in_progress' WHERE id=?").bind(other).run();
  const borrowed = await refusal(proof.mutateWalkingProof(db, {
    bookingId: booking.bookingId, action: "record_photo_update", actorId: WALKER, idempotencyKey: nextKey(),
    sessionId: other, mediaRef: mine.mediaRef, note: "Same dog, other walk",
  }));
  assert.equal(borrowed?.status, 403);
  assert.match(borrowed.message, /belongs to another session/);

  // Proof captured under the incident slot cannot stand in for a photo update.
  const incidentAsset = await cleanProof(db, booking, { purpose: "walking_incident" });
  const wrongSlot = await refusal(capture(db, booking, "record_photo_update", { mediaRef: incidentAsset.mediaRef, note: "Wrong slot" }));
  assert.equal(wrongSlot?.status, 409);
  assert.match(wrongSlot.message, /purpose does not match this evidence slot/);

  // A reference that is not a PawSpace media reference is refused outright.
  const raw = await refusal(capture(db, booking, "record_photo_update", { mediaRef: "https://cdn.example.com/walk.jpg", note: "Direct link" }));
  assert.equal(raw?.status, 400);
  assert.match(raw.message, /must use a PawSpace media reference/);

  const traversal = await refusal(capture(db, booking, "record_photo_update", { mediaRef: "media://asset/../../etc/passwd", note: "Traversal" }));
  assert.equal(traversal?.status, 400);
  assert.match(traversal.message, /Invalid PawSpace media asset reference/);

  const ghost = await refusal(capture(db, booking, "record_photo_update", { mediaRef: "media://asset/WMEDIA-DOESNOTEXIST", note: "Ghost" }));
  assert.equal(ghost?.status, 409);
  assert.match(ghost.message, /media asset does not exist/);
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking Gate 4 route samples are canonical but explicitly sandbox unverified", async () => {
  const { db, booking } = await proofWorld({ bookingId: "BKG-WALK-ROUTE" });

  const recorded = await capture(db, booking, "record_location_sample", {
    latitude: 12.9612, longitude: 77.6388, accuracyMeters: 12,
  });
  assert.equal(recorded.status, "recorded");
  assert.equal(recorded.environment, "sandbox");
  assert.equal(recorded.productionVerified, false, "a sandbox sample never claims production verification");

  const row = await db.prepare("SELECT detail_json FROM walking_session_events WHERE booking_id=? AND event_type='route_location_sample'").bind(booking.bookingId).first();
  const detail = JSON.parse(row.detail_json);
  assert.equal(detail.latitude, 12.9612);
  assert.equal(detail.accuracyMeters, 12);
  assert.equal(detail.environment, "sandbox");
  assert.equal(detail.productionVerified, false);

  // Coordinates and accuracy are bounded.
  for (const bad of [
    { latitude: 91, longitude: 77.6, accuracyMeters: 10 },
    { latitude: 12.9, longitude: 181, accuracyMeters: 10 },
    { latitude: 12.9, longitude: 77.6, accuracyMeters: 0 },
    { latitude: 12.9, longitude: 77.6, accuracyMeters: 501 },
    { latitude: Number.NaN, longitude: 77.6, accuracyMeters: 10 },
  ]) {
    const refused = await refusal(capture(db, booking, "record_location_sample", bad));
    assert.equal(refused?.status, 400);
    assert.match(refused.message, /Valid Dog Walking sandbox coordinates and accuracy are required/);
  }

  // Route evidence belongs to an ACTIVE walk only.
  await db.prepare("UPDATE walking_sessions SET status='ready_to_start' WHERE id=?").bind(booking.sessionId).run();
  const notActive = await refusal(capture(db, booking, "record_location_sample", { latitude: 12.96, longitude: 77.63, accuracyMeters: 8 }));
  assert.equal(notActive?.status, 409);
  assert.match(notActive.message, /only during an active walk/);

  const snapshot = await proof.getWalkingProofSnapshot(db, booking.bookingId);
  assert.equal(snapshot.routeEnvironment, "sandbox_unverified");
  assert.equal(snapshot.productionGpsConnected, false);
  assert.equal(snapshot.sandboxOnly, true);
  assert.deepEqual(snapshot.communications, { mode: "queued_only", liveDelivery: false });
  assert.equal(snapshot.routeSamples.length, 1);
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking Gate 4 incidents preserve booking and money authority", async () => {
  const { db, booking } = await proofWorld({ bookingId: "BKG-WALK-INCIDENT" });

  const thin = await refusal(capture(db, booking, "report_incident", { severity: "urgent", summary: "bad" }));
  assert.equal(thin?.status, 400);
  assert.match(thin.message, /Incident severity and summary are required/);

  const noSeverity = await refusal(capture(db, booking, "report_incident", { severity: "mild", summary: "The dog slipped its collar" }));
  assert.equal(noSeverity?.status, 400);

  const media = await cleanProof(db, booking, { purpose: "walking_incident" });
  const reported = await capture(db, booking, "report_incident", {
    severity: "urgent", summary: "The dog slipped its collar near the gate",
    actionTaken: "Recovered and re-leashed within a minute", mediaRef: media.mediaRef,
  });
  assert.equal(reported.status, "ops_escalation");
  assert.equal(reported.bookingPreserved, true);
  assert.equal(reported.automaticRefund, false, "an incident never triggers an automatic refund");
  assert.equal(reported.automaticPayoutChange, false, "an incident never moves the walker's payout by itself");
  assert.deepEqual(reported.communications, { mode: "queued_only", liveDelivery: false });

  // Money and booking state are untouched by the incident.
  assert.equal((await db.prepare("SELECT status FROM canonical_bookings WHERE id=?").bind(booking.bookingId).first()).status, "in_progress");
  assert.equal(
    Number((await db.prepare("SELECT COUNT(*) AS n FROM walking_refund_ledger WHERE booking_id=?").bind(booking.bookingId).first()).n),
    0,
    "reporting an incident opens no refund",
  );

  const incident = await db.prepare("SELECT severity,status,ops_status,media_id,reported_by,customer_acknowledged_at FROM walking_incidents WHERE id=?").bind(reported.incidentId).first();
  assert.equal(incident.severity, "urgent");
  assert.equal(incident.status, "open");
  assert.equal(incident.ops_status, "queued");
  assert.equal(incident.media_id, media.mediaId, "the incident carries governed proof, not a raw link");
  assert.equal(incident.customer_acknowledged_at, null);

  // The customer is told on both channels that nothing changed.
  const notes = await db.prepare("SELECT channel,message FROM walking_customer_notifications WHERE event_id=?").bind(reported.incidentId).all();
  assert.deepEqual(notes.results.map((row) => row.channel).sort(), ["push", "whatsapp"]);
  assert.match(notes.results[0].message, /booking and money state are unchanged/);

  // Neither acknowledgement nor resolution may come from the reporter.
  const selfAck = await refusal(capture(db, booking, "acknowledge_incident", { incidentId: reported.incidentId }));
  assert.equal(selfAck?.status, 403);
  assert.match(selfAck.message, /cannot be acknowledged by the actor who reported it/);

  const selfResolve = await refusal(capture(db, booking, "resolve_incident", { incidentId: reported.incidentId, resolution: "All fine now" }));
  assert.equal(selfResolve?.status, 403);
  assert.match(selfResolve.message, /cannot be resolved by the actor who reported it/);

  const customerAct = (action, extra) => proof.mutateWalkingProof(db, {
    bookingId: booking.bookingId, action, actorId: CUSTOMER, idempotencyKey: nextKey(),
    sessionId: booking.sessionId, ...extra,
  });

  const acknowledged = await customerAct("acknowledge_incident", { incidentId: reported.incidentId });
  assert.equal(acknowledged.customerAcknowledged, true);
  assert.equal(acknowledged.status, "open", "acknowledgement does not resolve the incident");
  assert.equal(acknowledged.automaticRefund, false, "the customer acknowledging changes no money");

  const twice = await customerAct("acknowledge_incident", { incidentId: reported.incidentId });
  assert.equal(twice.duplicateAcknowledgement, true);

  const thinResolution = await refusal(proof.mutateWalkingProof(db, {
    bookingId: booking.bookingId, action: "resolve_incident", actorId: REVIEWER,
    idempotencyKey: nextKey(), sessionId: booking.sessionId, incidentId: reported.incidentId, resolution: "ok",
  }));
  assert.equal(thinResolution?.status, 400);
  assert.match(thinResolution.message, /Incident resolution is required/);

  const resolved = await proof.mutateWalkingProof(db, {
    bookingId: booking.bookingId, action: "resolve_incident", actorId: REVIEWER, idempotencyKey: nextKey(),
    sessionId: booking.sessionId, incidentId: reported.incidentId, resolution: "Collar replaced; owner briefed",
  });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.automaticRefund, false);
  assert.equal(resolved.automaticPayoutChange, false);

  const closed = await db.prepare("SELECT status,ops_status,resolution,resolved_by FROM walking_incidents WHERE id=?").bind(reported.incidentId).first();
  assert.equal(closed.status, "resolved");
  assert.equal(closed.ops_status, "resolved");
  assert.equal(closed.resolved_by, REVIEWER);

  // Money is STILL untouched after a full incident lifecycle.
  assert.equal(
    Number((await db.prepare("SELECT COUNT(*) AS n FROM walking_refund_ledger WHERE booking_id=?").bind(booking.bookingId).first()).n),
    0,
    "resolving an incident opens no refund either",
  );

  const missing = await proof.mutateWalkingProof(db, {
    bookingId: booking.bookingId, action: "resolve_incident", actorId: REVIEWER, idempotencyKey: nextKey(),
    sessionId: booking.sessionId, incidentId: "NOPE", resolution: "Nothing to resolve",
  }).then(() => null, (error) => error);
  assert.equal(missing?.status, 404);

  // An incident belongs to a walk that is actually happening. Once the walk is over, the Operations
  // incident workflow -- not the walker's live proof surface -- owns it.
  await db.prepare("UPDATE walking_sessions SET status='completed' WHERE id=?").bind(booking.sessionId).run();
  const afterTheWalk = await refusal(capture(db, booking, "report_incident", {
    severity: "attention", summary: "Remembered something the next morning",
  }));
  assert.equal(afterTheWalk?.status, 409);
  assert.match(afterTheWalk.message, /Dog Walking incidents require an active walk/);
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking proof actions are replay safe and bounded", async () => {
  const { db, booking } = await proofWorld({ bookingId: "BKG-WALK-REPLAY" });

  const key = nextKey();
  const body = {
    bookingId: booking.bookingId, action: "record_location_sample", actorId: WALKER, idempotencyKey: key,
    sessionId: booking.sessionId, latitude: 12.9613, longitude: 77.6389, accuracyMeters: 9,
  };
  await proof.mutateWalkingProof(db, body);
  const replay = await proof.mutateWalkingProof(db, body);
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(
    Number((await db.prepare("SELECT COUNT(*) AS n FROM walking_session_events WHERE booking_id=? AND event_type='route_location_sample'").bind(booking.bookingId).first()).n),
    1,
    "a replayed sample is not recorded twice",
  );

  const incomplete = await refusal(proof.mutateWalkingProof(db, { bookingId: booking.bookingId, action: "record_location_sample", actorId: WALKER }));
  assert.equal(incomplete?.status, 400);
  assert.match(incomplete.message, /Booking, action, actor and idempotency key are required/);

  const unsupported = await refusal(capture(db, booking, "delete_everything", {}));
  assert.equal(unsupported?.status, 400);
  assert.match(unsupported.message, /Unsupported Dog Walking proof action/);

  const unknownBooking = await refusal(proof.mutateWalkingProof(db, {
    bookingId: "BKG-NOPE", action: "record_location_sample", actorId: WALKER, idempotencyKey: nextKey(),
    sessionId: booking.sessionId, latitude: 12.96, longitude: 77.63, accuracyMeters: 5,
  }));
  assert.equal(unknownBooking?.status, 404);
  assert.match(unknownBooking.message, /Dog Walking booking not found/);

  const unknownSession = await refusal(capture(db, booking, "record_location_sample", {
    sessionId: "WSESS-NOPE", latitude: 12.96, longitude: 77.63, accuracyMeters: 5,
  }));
  assert.equal(unknownSession?.status, 404);
  assert.match(unknownSession.message, /Dog Walking session not found/);
});
