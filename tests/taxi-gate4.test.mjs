/**
 * Pet Taxi Gate 4 — proof, media and incidents. EXECUTED.
 *
 * WHAT THIS FILE USED TO BE. Seven tests that read `lib/taxi-proof-governance.ts`, its route and three
 * React page files as strings. One asserted `assert.match(source, /15\*60_000/)` — the literal
 * expression, not the fifteen-minute expiry. Another asserted `assert.match(source, /token_hash/)`,
 * which the column name appearing anywhere satisfies, and which would still pass if the raw token were
 * stored in it. A third proved the driver cannot self-approve a scan with
 * `assert.doesNotMatch(page, /record_media_scan/)` — a claim about a React file, when the guard that
 * matters is on the server.
 *
 * Now seven EXECUTED tests driving `mutateTaxiProof`, `getTaxiProofSnapshot` and the real
 * `POST /api/taxi-proof` against a real SQLite-backed D1, reading `service_media_assets`,
 * `taxi_media_upload_grants`, `taxi_media_trip_bindings`, `taxi_trip_events` and `taxi_incidents` back.
 *
 * Requests go to https://ops.pawspace.example. This file's central claim is that a DRIVER, a CUSTOMER
 * and STAFF have different authority over the same evidence, and that the submitter of a photo cannot
 * be its scan approver. On localhost `npm test` resolves one preview superuser holding ["*"] for every
 * request, so every one of those separations would pass vacuously.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { customerSessionCookie, freshSqlite, makeD1, nextKey, refusal, seedCanonicalTrip, taxiUrl } from "./helpers/taxi-harness.mjs";

installWorkersHooks("__TAXI_G4_DB__", "__TAXI_G4_ENV__");

const proof = await import("../lib/taxi-proof-governance.ts");
const proofRoute = await import("../app/api/taxi-proof/route.ts");

const CUSTOMER_PRINCIPAL = "+919800000041";
const DRIVER_PRINCIPAL = "+919700000041";
const DRIVER_ACTOR = "customer:CUST-TAXI-1";
const OPS_STAFF = "ops.staff@pawspace.test";
const OPS_SECOND = "ops.second@pawspace.test";
const SUPPORT = "support.agent@pawspace.test";
const SHA = "a".repeat(64);

/** A canonical trip in a chosen trip state, with proof tables and three staff identities. */
async function proofWorld({ tripStatus = "in_progress" } = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__TAXI_G4_DB__ = db;
  globalThis.__TAXI_G4_ENV__ = {};

  const seeded = seedCanonicalTrip(sqlite, { tripStatus, workOrderStatus: "accepted", offerStatus: "accepted", vehicleId: "VEH-1" });
  sqlite.prepare("UPDATE canonical_bookings SET status='in_progress' WHERE id=?").run(seeded.bookingId);
  await proof.ensureTaxiProofTables(db);

  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const now = Date.now();
  const staff = sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)");
  // `admin` holds bookings.manage, which is the staff authority these actions require.
  staff.run("U-G4-OPS", OPS_STAFF, "Ops Staff", "admin", now, now);
  staff.run("U-G4-OPS2", OPS_SECOND, "Second Ops", "admin", now, now);
  // `associate` sees bookings but does not manage them — the contrast that makes the staff gate real.
  staff.run("U-G4-SUPPORT", SUPPORT, "Support Agent", "associate", now, now);
  return { sqlite, db, ...seeded };
}

const mutate = (db, bookingId, action, extra = {}) =>
  proof.mutateTaxiProof(db, { bookingId, action, actorId: extra.actorId ?? DRIVER_ACTOR, idempotencyKey: extra.key ?? nextKey(action), ...extra });

/** A valid prepare_media payload; a test varies ONE field so a refusal is attributable. */
const prepareInput = (overrides = {}) => ({ purpose: "taxi_update", mimeType: "image/jpeg", sizeBytes: 250_000, sha256: SHA, ...overrides });

/** Take a photo all the way to clean, private, active proof, using two distinct identities. */
async function cleanProof(db, bookingId, { purpose = "taxi_update", submitter = DRIVER_ACTOR, approver = OPS_STAFF } = {}) {
  const prepared = await mutate(db, bookingId, "prepare_media", { ...prepareInput({ purpose }), actorId: submitter });
  await mutate(db, bookingId, "sandbox_finalize_media", { actorId: OPS_STAFF, uploadToken: prepared.upload.token, storageObjectId: `objects/${prepared.mediaId}` });
  await mutate(db, bookingId, "record_media_scan", { actorId: approver, mediaRef: prepared.mediaRef, scanResult: "clean" });
  return prepared;
}

const mediaRow = (sqlite, mediaId) => sqlite.prepare("SELECT * FROM service_media_assets WHERE id=?").get(mediaId);
const grantRow = (sqlite, mediaId) => sqlite.prepare("SELECT * FROM taxi_media_upload_grants WHERE media_id=?").get(mediaId);
const routeSamples = (sqlite, bookingId) => sqlite.prepare("SELECT detail_json FROM taxi_trip_events WHERE booking_id=? AND event_type='route_location_sample' ORDER BY created_at").all(bookingId);

// ---------------------------------------------------------------------------------------------
test("Gate 4: an upload grant is private, fifteen minutes long, and bound to one booking/trip/driver", async () => {
  const world = await proofWorld();
  const { sqlite, db, bookingId, tripId, providerId } = world;

  const before = Date.now();
  const prepared = await mutate(db, bookingId, "prepare_media", prepareInput());
  const after = Date.now();

  // FIFTEEN MINUTES, measured. The old test asserted the characters "15*60_000" appeared in the file.
  assert.ok(prepared.upload.expiresAt >= before + 15 * 60_000 && prepared.upload.expiresAt <= after + 15 * 60_000,
    `the grant must expire fifteen minutes out, not ${(prepared.upload.expiresAt - before) / 60_000} minutes`);
  assert.equal(prepared.upload.mode, "sandbox_contract");
  assert.equal(prepared.upload.adapterConnected, false, "no storage adapter is connected");
  assert.equal(prepared.upload.rawPublicUrl, false);
  assert.equal(prepared.proofReady, false, "a grant is not proof");
  assert.equal(prepared.mediaRef, `media://asset/${prepared.mediaId}`, "media is addressed by an opaque ref, never a URL");
  assert.equal(prepared.mediaRef.includes("http"), false);

  // THE TOKEN IS NOT STORED. Only its digest is, so a database read cannot be replayed as an upload.
  const grant = grantRow(sqlite, prepared.mediaId);
  assert.equal(String(grant.status), "issued");
  assert.notEqual(String(grant.token_hash), prepared.upload.token);
  assert.match(String(grant.token_hash), /^[a-f0-9]{64}$/, "the stored value is a SHA-256 digest");
  assert.equal(String(grant.token_hash).includes(prepared.upload.token.split(".")[1]), false, "and the secret half never appears in it");

  // TRIP-BOUND: the grant, the binding and the asset all name the same booking, trip and driver.
  assert.deepEqual([String(grant.booking_id), String(grant.trip_id), String(grant.provider_id)], [bookingId, tripId, providerId]);
  const binding = sqlite.prepare("SELECT * FROM taxi_media_trip_bindings WHERE media_id=?").get(prepared.mediaId);
  assert.deepEqual([String(binding.booking_id), String(binding.trip_id), String(binding.provider_id)], [bookingId, tripId, providerId]);
  const asset = mediaRow(sqlite, prepared.mediaId);
  assert.deepEqual({ scan: String(asset.scan_status), access: String(asset.access_status), retention: String(asset.retention_status), synthetic: Number(asset.synthetic) },
    { scan: "pending", access: "pending_upload", retention: "active", synthetic: 0 },
    "a fresh asset is unscanned and not yet readable");
  // The storage key is a private pending path, not a public URL.
  assert.equal(String(asset.storage_key), `taxi/pending/${bookingId}/${tripId}/${prepared.mediaId}`);

  // AN EXPIRED GRANT cannot be finalized, and a WRONG TOKEN cannot either.
  const expired = await mutate(db, bookingId, "prepare_media", prepareInput({ purpose: "taxi_dropoff" }));
  sqlite.prepare("UPDATE taxi_media_upload_grants SET expires_at=? WHERE media_id=?").run(Date.now() - 1000, expired.mediaId);
  assert.equal((await refusal(mutate(db, bookingId, "sandbox_finalize_media", { actorId: OPS_STAFF, uploadToken: expired.upload.token, storageObjectId: "objects/expired" })))?.status, 409);
  const grantId = prepared.upload.token.split(".")[0];
  assert.equal((await refusal(mutate(db, bookingId, "sandbox_finalize_media", { actorId: OPS_STAFF, uploadToken: `${grantId}.wrongsecret`, storageObjectId: "objects/forged" })))?.status, 403,
    "a forged token for a real grant is refused");
  assert.equal(String(grantRow(sqlite, prepared.mediaId).status), "issued", "and the grant is still unconsumed");

  // A PUBLIC URL is refused as a storage confirmation: proof must stay behind an opaque object id.
  assert.equal((await refusal(mutate(db, bookingId, "sandbox_finalize_media", { actorId: OPS_STAFF, uploadToken: prepared.upload.token, storageObjectId: "https://cdn.example.com/leaked.jpg" })))?.status, 400);
  assert.equal((await refusal(mutate(db, bookingId, "sandbox_finalize_media", { actorId: OPS_STAFF, uploadToken: prepared.upload.token, storageObjectId: "short" })))?.status, 400);

  // The real finalize consumes the grant ONCE and quarantines the object.
  const finalized = await mutate(db, bookingId, "sandbox_finalize_media", { actorId: OPS_STAFF, uploadToken: prepared.upload.token, storageObjectId: `objects/${prepared.mediaId}` });
  assert.equal(finalized.status, "quarantined");
  assert.equal(finalized.proofReady, false);
  assert.equal(String(grantRow(sqlite, prepared.mediaId).status), "consumed");
  assert.equal(String(mediaRow(sqlite, prepared.mediaId).storage_key), `taxi/object/objects/${prepared.mediaId}`);
  assert.equal((await refusal(mutate(db, bookingId, "sandbox_finalize_media", { actorId: OPS_STAFF, uploadToken: prepared.upload.token, storageObjectId: `objects/${prepared.mediaId}` })))?.status, 409,
    "a consumed grant cannot be replayed");
});

// ---------------------------------------------------------------------------------------------
test("Gate 4: proof capture enforces MIME, size, checksum and an open trip", async () => {
  const world = await proofWorld();
  const { sqlite, db, bookingId } = world;

  // NON-VACUITY: each accepted image type really is accepted.
  for (const mimeType of ["image/jpeg", "image/png", "image/webp"]) {
    const ok = await mutate(db, bookingId, "prepare_media", prepareInput({ mimeType }));
    assert.equal(String(mediaRow(sqlite, ok.mediaId).mime_type), mimeType);
  }
  // And anything else is refused — including formats that can carry a script.
  for (const mimeType of ["image/svg+xml", "image/gif", "application/pdf", "text/html", "image/heic", ""]) {
    assert.equal((await refusal(mutate(db, bookingId, "prepare_media", prepareInput({ mimeType }))))?.status, 400, `${mimeType || "(empty)"} must be refused`);
  }

  // SIZE bounds, both ends, measured against the real 10 MB ceiling.
  assert.equal((await mutate(db, bookingId, "prepare_media", prepareInput({ sizeBytes: 1 }))).proofReady, false, "one byte is inside the range");
  assert.equal((await mutate(db, bookingId, "prepare_media", prepareInput({ sizeBytes: 10_000_000 }))).proofReady, false, "and so is exactly 10 MB");
  for (const sizeBytes of [0, -1, 10_000_001, Number.NaN]) {
    assert.equal((await refusal(mutate(db, bookingId, "prepare_media", prepareInput({ sizeBytes }))))?.status, 400, `${sizeBytes} must be refused`);
  }

  // A CHECKSUM is mandatory and must be a real SHA-256, so the stored digest cannot be a placeholder.
  for (const sha256 of ["", "not-a-digest", "a".repeat(63), "a".repeat(65), "z".repeat(64)]) {
    assert.equal((await refusal(mutate(db, bookingId, "prepare_media", prepareInput({ sha256 }))))?.status, 400, `${sha256 || "(empty)"} must be refused`);
  }
  const upper = await mutate(db, bookingId, "prepare_media", prepareInput({ sha256: "A".repeat(64) }));
  assert.equal(String(mediaRow(sqlite, upper.mediaId).sha256), "A".repeat(64), "an upper-case digest is still a digest");

  // The PURPOSE vocabulary is closed to the taxi evidence slots.
  assert.equal((await refusal(mutate(db, bookingId, "prepare_media", prepareInput({ purpose: "grooming_before" }))))?.status, 400);
  assert.equal((await refusal(mutate(db, bookingId, "prepare_media", prepareInput({ purpose: undefined }))))?.status, 400);

  // A trip that is not open for capture refuses proof outright, in either direction.
  const scheduled = await proofWorld({ tripStatus: "scheduled" });
  assert.equal((await refusal(mutate(scheduled.db, scheduled.bookingId, "prepare_media", prepareInput())))?.status, 409);
  const completed = await proofWorld({ tripStatus: "completed" });
  assert.equal((await refusal(mutate(completed.db, completed.bookingId, "prepare_media", prepareInput())))?.status, 409);
  assert.equal(Number(scheduled.sqlite.prepare("SELECT COUNT(*) c FROM service_media_assets").get().c), 0);

  // ONLY clean, private, active, non-synthetic media counts as proof. A quarantined photo is refused
  // as a photo update, and so is one whose purpose belongs to a different evidence slot.
  const quarantined = await mutate(db, bookingId, "prepare_media", prepareInput());
  await mutate(db, bookingId, "sandbox_finalize_media", { actorId: OPS_STAFF, uploadToken: quarantined.upload.token, storageObjectId: `objects/${quarantined.mediaId}` });
  assert.equal((await refusal(mutate(db, bookingId, "record_photo_update", { mediaRef: quarantined.mediaRef, note: "before the trip" })))?.status, 409);
  const clean = await cleanProof(db, bookingId);
  const wrongSlot = await cleanProof(db, bookingId, { purpose: "taxi_dropoff" });
  assert.equal((await refusal(mutate(db, bookingId, "record_photo_update", { mediaRef: wrongSlot.mediaRef, note: "wrong evidence slot" })))?.status, 409);
  // A REVOKED photo stops being proof immediately.
  const revocable = await cleanProof(db, bookingId);
  await mutate(db, bookingId, "revoke_media", { actorId: OPS_STAFF, mediaRef: revocable.mediaRef, reason: "customer asked for removal" });
  assert.deepEqual({ access: String(mediaRow(sqlite, revocable.mediaId).access_status), retention: String(mediaRow(sqlite, revocable.mediaId).retention_status) },
    { access: "revoked", retention: "revoked" });
  assert.equal((await refusal(mutate(db, bookingId, "record_photo_update", { mediaRef: revocable.mediaRef, note: "using revoked proof" })))?.status, 409);

  /*
   * ANOTHER BOOKING'S PROOF cannot be presented on this trip. Media is bound to a booking, a trip and a
   * driver, and all three are checked.
   *
   * SABOTAGE NOTE. Dropping the trip-id half of that check alone does not redden this, and cannot:
   * taxi_trips.booking_id is UNIQUE, so media bound to a different trip is necessarily bound to a
   * different booking, and the booking clause refuses it first. The trip clause is redundant with the
   * booking clause through the schema. Recorded as an equivalent mutation; the booking and driver
   * clauses are covered here.
   */
  const otherTrip = seedCanonicalTrip(sqlite, { bookingId: "BKG-TAXI-G4C", tripId: "TRIP-G4C", reservationId: "RES-G4C", groupId: "GRP-G4C", customerId: "CUST-TAXI-G4C", providerId: "taxi_other", tripStatus: "in_progress" });
  const foreign = await cleanProof(db, otherTrip.bookingId, { submitter: "customer:CUST-TAXI-G4C" });
  assert.equal((await refusal(mutate(db, bookingId, "record_photo_update", { mediaRef: foreign.mediaRef, note: "another trip's photo" })))?.status, 403,
    "one trip's proof cannot be presented as another's");
  assert.equal((await refusal(mutate(db, bookingId, "report_incident", { mediaRef: foreign.mediaRef, severity: "urgent", summary: "attaching another trip's photo" })))?.status, 403);

  // The clean one works, and a note is mandatory — non-vacuity for all of the above.
  assert.equal((await refusal(mutate(db, bookingId, "record_photo_update", { mediaRef: clean.mediaRef, note: "x" })))?.status, 400);
  const recorded = await mutate(db, bookingId, "record_photo_update", { mediaRef: clean.mediaRef, note: "pet loaded safely" });
  assert.equal(recorded.canonicalRequirement, "Before Picture");
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM taxi_trip_events WHERE booking_id=? AND event_type='proof_photo_update'").get(bookingId).c), 1);
});

// ---------------------------------------------------------------------------------------------
test("Gate 4: a photo cannot be scan-approved by the identity that submitted it", async () => {
  const world = await proofWorld();
  const { sqlite, db, bookingId } = world;
  const prepared = await mutate(db, bookingId, "prepare_media", prepareInput());
  await mutate(db, bookingId, "sandbox_finalize_media", { actorId: OPS_STAFF, uploadToken: prepared.upload.token, storageObjectId: `objects/${prepared.mediaId}` });

  // THE SUBMITTER cannot pass their own photo. The old test asserted a React page did not contain the
  // string "record_media_scan"; this is the server guard that actually holds.
  assert.equal((await refusal(mutate(db, bookingId, "record_media_scan", { actorId: DRIVER_ACTOR, mediaRef: prepared.mediaRef, scanResult: "clean" })))?.status, 403);
  assert.deepEqual({ scan: String(mediaRow(sqlite, prepared.mediaId).scan_status), access: String(mediaRow(sqlite, prepared.mediaId).access_status) },
    { scan: "pending", access: "quarantined" }, "and the photo stays quarantined");

  // The scan verdict vocabulary is closed: "probably fine" is not a verdict.
  assert.equal((await refusal(mutate(db, bookingId, "record_media_scan", { actorId: OPS_STAFF, mediaRef: prepared.mediaRef, scanResult: "probably_fine" })))?.status, 400);
  // Media belonging to another booking cannot be scanned through this one.
  const other = seedCanonicalTrip(sqlite, { bookingId: "BKG-TAXI-G4B", tripId: "TRIP-G4B", reservationId: "RES-G4B", groupId: "GRP-G4B", customerId: "CUST-TAXI-G4B", providerId: "taxi_other", tripStatus: "in_progress" });
  assert.equal((await refusal(mutate(db, other.bookingId, "record_media_scan", { actorId: OPS_SECOND, mediaRef: prepared.mediaRef, scanResult: "clean" })))?.status, 403);

  // A DISTINCT operator can, and only then is the photo readable.
  const scanned = await mutate(db, bookingId, "record_media_scan", { actorId: OPS_STAFF, mediaRef: prepared.mediaRef, scanResult: "clean" });
  assert.deepEqual({ scan: scanned.scanStatus, access: scanned.accessStatus, ready: scanned.proofReady }, { scan: "clean", access: "ready", ready: true });
  // And it cannot be scanned twice — a rejected photo cannot be quietly re-passed.
  assert.equal((await refusal(mutate(db, bookingId, "record_media_scan", { actorId: OPS_SECOND, mediaRef: prepared.mediaRef, scanResult: "clean" })))?.status, 409);

  // A REJECTED scan leaves the photo quarantined and never readable.
  const bad = await mutate(db, bookingId, "prepare_media", prepareInput({ purpose: "taxi_incident" }));
  await mutate(db, bookingId, "sandbox_finalize_media", { actorId: OPS_STAFF, uploadToken: bad.upload.token, storageObjectId: `objects/${bad.mediaId}` });
  const rejected = await mutate(db, bookingId, "record_media_scan", { actorId: OPS_STAFF, mediaRef: bad.mediaRef, scanResult: "rejected", reason: "malware signature" });
  assert.deepEqual({ scan: rejected.scanStatus, access: rejected.accessStatus, ready: rejected.proofReady }, { scan: "rejected", access: "quarantined", ready: false });
  assert.equal((await refusal(mutate(db, bookingId, "report_incident", { mediaRef: bad.mediaRef, severity: "urgent", summary: "pet unsettled during the trip" })))?.status, 409,
    "rejected media cannot be attached as incident evidence");

  // Every media transition is journalled, so the scan decision has an owner.
  const events = sqlite.prepare("SELECT event_type,actor_id FROM service_media_events WHERE media_id=? ORDER BY created_at").all(prepared.mediaId);
  assert.deepEqual(events.map((row) => String(row.event_type)), ["taxi_upload_grant_issued", "taxi_upload_finalized", "taxi_scan_passed"]);
  assert.equal(String(events[2].actor_id), OPS_STAFF, "the approver on the record is the approving identity");
});

// ---------------------------------------------------------------------------------------------
test("Gate 4: route samples are deterministic-sandbox evidence and say they are not production", async () => {
  const world = await proofWorld();
  const { sqlite, db, bookingId } = world;

  const sample = await mutate(db, bookingId, "record_location_sample", { latitude: 12.9716, longitude: 77.5946, accuracyMeters: 12 });
  assert.equal(sample.status, "recorded");
  // The telemetry declares its own provenance. The old test asserted the strings
  // `environment:"deterministic_sandbox"` and `productionVerified:false` appeared in the module.
  assert.equal(sample.environment, "deterministic_sandbox");
  assert.equal(sample.gpsConnected, true, "the sandbox GPS source is connected");
  assert.equal(sample.productionVerified, false, "and it is explicitly not production-verified");
  const stored = JSON.parse(String(routeSamples(sqlite, bookingId)[0].detail_json));
  assert.deepEqual(stored, { latitude: 12.9716, longitude: 77.5946, accuracyMeters: 12, environment: "deterministic_sandbox", gpsConnected: true, productionVerified: false },
    "and the row carries the same provenance, not just the response");

  // COORDINATES are validated, so a sample cannot be recorded at an impossible place or accuracy.
  for (const bad of [
    { latitude: 91, longitude: 77 }, { latitude: -91, longitude: 77 },
    { latitude: 12, longitude: 181 }, { latitude: 12, longitude: -181 },
    { latitude: Number.NaN, longitude: 77 }, { latitude: 12, longitude: 77, accuracyMeters: 0 },
    { latitude: 12, longitude: 77, accuracyMeters: -5 }, { latitude: 12, longitude: 77, accuracyMeters: 501 },
  ]) {
    assert.equal((await refusal(mutate(db, bookingId, "record_location_sample", { accuracyMeters: 10, ...bad })))?.status, 400, `${JSON.stringify(bad)} must be refused`);
  }
  assert.equal(routeSamples(sqlite, bookingId).length, 1, "and no refused sample was recorded");

  // Samples are only accepted DURING the trip: not before it starts, not after it ends.
  const scheduled = await proofWorld({ tripStatus: "scheduled" });
  assert.equal((await refusal(mutate(scheduled.db, scheduled.bookingId, "record_location_sample", { latitude: 12, longitude: 77, accuracyMeters: 10 })))?.status, 409);
  const arrived = await proofWorld({ tripStatus: "arrived_dropoff" });
  assert.equal((await refusal(mutate(arrived.db, arrived.bookingId, "record_location_sample", { latitude: 12, longitude: 77, accuracyMeters: 10 })))?.status, 409);

  // THE SNAPSHOT the driver and Operations screens read declares the same limits, and names the two
  // canonical proof requirements as values rather than as text in a file.
  await mutate(db, bookingId, "record_location_sample", { latitude: 12.98, longitude: 77.6, accuracyMeters: 9 });
  const snapshot = await proof.getTaxiProofSnapshot(db, bookingId);
  assert.equal(snapshot.routeEnvironment, "deterministic_sandbox");
  assert.equal(snapshot.gpsConnected, true);
  assert.equal(snapshot.productionGpsConnected, false);
  assert.equal(snapshot.productionMapsVerified, false);
  assert.equal(snapshot.sandboxOnly, true);
  assert.deepEqual(snapshot.communications, { mode: "queued_only", liveDelivery: false });
  assert.equal(snapshot.routeSamples.length, 2, "the snapshot reports the samples actually recorded");
  assert.deepEqual(snapshot.canonicalProofRequirements.map((item) => [item.key, item.label, item.purpose]),
    [["before", "Before Picture", "taxi_update"], ["after", "After Picture", "taxi_dropoff"]]);
  assert.deepEqual(proof.TAXI_CANONICAL_PROOF_REQUIREMENTS.map((item) => item.label), ["Before Picture", "After Picture"]);
  // Media reaches the snapshot as an opaque ref, never as a storage path or URL.
  const clean = await cleanProof(db, bookingId);
  const refreshed = await proof.getTaxiProofSnapshot(db, bookingId);
  const entry = refreshed.media.find((item) => String(item.id) === clean.mediaId);
  assert.equal(entry.mediaRef, `media://asset/${clean.mediaId}`);
  assert.equal(Object.values(entry).some((value) => String(value).includes("http")), false, "no snapshot field leaks a URL");
});

// ---------------------------------------------------------------------------------------------
test("Gate 4: an incident escalates to Operations and changes no booking or money state", async () => {
  const world = await proofWorld();
  const { sqlite, db, bookingId, tripId } = world;
  const bookingBefore = sqlite.prepare("SELECT status,total_amount FROM canonical_bookings WHERE id=?").get(bookingId);
  const paymentBefore = sqlite.prepare("SELECT status,amount FROM booking_payments WHERE booking_id=?").get(bookingId);

  // Severity and a real summary are mandatory.
  assert.equal((await refusal(mutate(db, bookingId, "report_incident", { severity: "spicy", summary: "something happened" })))?.status, 400);
  assert.equal((await refusal(mutate(db, bookingId, "report_incident", { severity: "urgent", summary: "bad" })))?.status, 400);

  // NON-VACUITY: all three real severities are accepted, and each records itself.
  for (const severity of ["attention", "urgent", "emergency"]) {
    const reported = await mutate(db, bookingId, "report_incident", { severity, summary: `pet showed signs of ${severity}` });
    assert.equal(reported.status, "ops_escalation", "an incident escalates rather than resolving itself");
    assert.equal(reported.bookingPreserved, true);
    assert.equal(reported.automaticRefund, false, "reporting an incident never refunds anyone");
    assert.equal(reported.automaticPayoutChange, false, "and never changes a driver's payout");
    assert.deepEqual(reported.communications, { mode: "queued_only", liveDelivery: false });
    const row = sqlite.prepare("SELECT * FROM taxi_incidents WHERE id=?").get(reported.incidentId);
    assert.deepEqual({ severity: String(row.severity), status: String(row.status), ops: String(row.ops_status), notification: String(row.notification_status) },
      { severity, status: "open", ops: "queued", notification: "queued" });
    assert.equal(String(row.trip_id), tripId);
  }

  // NOT ONE booking or money field moved.
  assert.deepEqual(sqlite.prepare("SELECT status,total_amount FROM canonical_bookings WHERE id=?").get(bookingId), bookingBefore);
  assert.deepEqual(sqlite.prepare("SELECT status,amount FROM booking_payments WHERE booking_id=?").get(bookingId), paymentBefore);
  // taxi_refund_ledger belongs to Gate 3 and this module never creates it — its ABSENCE here is itself
  // the statement that the proof path cannot touch refunds.
  assert.equal(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='taxi_refund_ledger'").get(), undefined,
    "the proof module must not so much as provision a refund ledger");

  // Customer notifications are QUEUED, never delivered — there is no live channel connected.
  const notifications = sqlite.prepare("SELECT channel,status FROM taxi_customer_notifications WHERE booking_id=?").all(bookingId);
  assert.ok(notifications.length >= 6, "each incident queues a push and a WhatsApp message");
  assert.deepEqual([...new Set(notifications.map((row) => String(row.status)))], ["queued"]);
  assert.deepEqual([...new Set(notifications.map((row) => String(row.channel)))].sort(), ["push", "whatsapp"]);

  // ACKNOWLEDGEMENT and RESOLUTION both need a different identity from the reporter, and neither
  // touches money.
  const incidentId = String(sqlite.prepare("SELECT id FROM taxi_incidents WHERE booking_id=? ORDER BY reported_at LIMIT 1").get(bookingId).id);
  assert.equal((await refusal(mutate(db, bookingId, "acknowledge_incident", { actorId: DRIVER_ACTOR, incidentId })))?.status, 403);
  assert.equal((await refusal(mutate(db, bookingId, "resolve_incident", { actorId: DRIVER_ACTOR, incidentId, resolution: "resolved it myself" })))?.status, 403);
  assert.equal((await refusal(mutate(db, bookingId, "resolve_incident", { actorId: OPS_STAFF, incidentId, resolution: "ok" })))?.status, 400, "a resolution must say something");
  assert.equal(String(sqlite.prepare("SELECT status FROM taxi_incidents WHERE id=?").get(incidentId).status), "open");

  const acknowledged = await mutate(db, bookingId, "acknowledge_incident", { actorId: "customer:CUST-ACK", incidentId });
  assert.equal(acknowledged.customerAcknowledged, true);
  assert.equal(acknowledged.automaticRefund, false, "acknowledging is not accepting a settlement");
  assert.equal(acknowledged.status, "open", "and it does not close the incident");
  const twice = await mutate(db, bookingId, "acknowledge_incident", { actorId: "customer:CUST-ACK", incidentId });
  assert.equal(twice.duplicateAcknowledgement, true);

  const resolved = await mutate(db, bookingId, "resolve_incident", { actorId: OPS_STAFF, incidentId, resolution: "driver stopped, pet checked, trip resumed" });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.automaticRefund, false);
  assert.equal(resolved.automaticPayoutChange, false);
  const closed = sqlite.prepare("SELECT status,ops_status,resolved_by,resolution FROM taxi_incidents WHERE id=?").get(incidentId);
  assert.deepEqual({ status: String(closed.status), ops: String(closed.ops_status), by: String(closed.resolved_by) }, { status: "resolved", ops: "resolved", by: OPS_STAFF });
  assert.deepEqual(sqlite.prepare("SELECT status,total_amount FROM canonical_bookings WHERE id=?").get(bookingId), bookingBefore,
    "and resolving still changes no booking state");
});

// ---------------------------------------------------------------------------------------------
test("Gate 4: the proof API separates driver, customer and staff authority", async () => {
  const world = await proofWorld();
  const { sqlite, db, bookingId, customerId, providerId } = world;
  const driver = await customerSessionCookie(db, { principalKey: DRIVER_PRINCIPAL, customerId: providerId, subjectType: "provider" });
  const customer = await customerSessionCookie(db, { principalKey: CUSTOMER_PRINCIPAL, customerId });
  const otherDriver = await customerSessionCookie(db, { principalKey: "+919700000099", customerId: "taxi_someone_else", subjectType: "provider" });

  const post = async (session, body) => {
    const headers = { "content-type": "application/json", ...(session.cookie ? { cookie: session.cookie } : {}), ...(session.staff ? { "oai-authenticated-user-email": session.staff } : {}) };
    const response = await proofRoute.POST(new Request(taxiUrl("/api/taxi-proof"), { method: "POST", headers, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const get = async (session, query) => {
    const headers = { ...(session.cookie ? { cookie: session.cookie } : {}), ...(session.staff ? { "oai-authenticated-user-email": session.staff } : {}) };
    const response = await proofRoute.GET(new Request(taxiUrl(`/api/taxi-proof?${query}`), { headers }));
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  // THE DRIVER may capture evidence for their own trip.
  const prepared = await post(driver, { bookingId, action: "prepare_media", idempotencyKey: nextKey("route"), ...prepareInput() });
  assert.equal(prepared.status, 200, `the assigned driver must be able to prepare media: ${JSON.stringify(prepared)}`);
  const sampled = await post(driver, { bookingId, action: "record_location_sample", idempotencyKey: nextKey("route"), latitude: 12.97, longitude: 77.59, accuracyMeters: 11 });
  assert.equal(sampled.status, 200);
  // The body tries to claim a different acting identity; the route must ignore it and record the
  // session's own.
  const reported = await post(driver, { bookingId, action: "report_incident", idempotencyKey: nextKey("route"), severity: "urgent", summary: "pet is distressed in traffic", actorId: OPS_STAFF });
  assert.equal(reported.status, 202, "an incident is accepted for Operations review, not resolved");
  assert.equal(String(sqlite.prepare("SELECT reported_by FROM taxi_incidents WHERE id=?").get(reported.body.data.incidentId).reported_by), `provider:${providerId}`,
    "the reporter on the record is the authenticated driver, not the body's claim");

  // ANOTHER DRIVER cannot, even with an equally valid session.
  const intruder = await post(otherDriver, { bookingId, action: "prepare_media", idempotencyKey: nextKey("route"), ...prepareInput() });
  assert.ok([401, 403].includes(intruder.status), `a different driver must be refused: ${JSON.stringify(intruder)}`);

  // THE DRIVER CANNOT self-approve storage or scan state. This is the guard the old test looked for in
  // a React file.
  for (const action of ["sandbox_finalize_media", "record_media_scan", "revoke_media", "resolve_incident"]) {
    const attempt = await post(driver, { bookingId, action, idempotencyKey: nextKey("route"), uploadToken: prepared.body.data.upload.token, storageObjectId: "objects/self", mediaRef: prepared.body.data.mediaRef, scanResult: "clean", incidentId: reported.body.data.incidentId, resolution: "resolved by the driver" });
    assert.ok([401, 403].includes(attempt.status), `${action} must be staff-only: ${JSON.stringify(attempt)}`);
  }
  assert.deepEqual({ scan: String(sqlite.prepare("SELECT scan_status FROM service_media_assets WHERE id=?").get(prepared.body.data.mediaId).scan_status), access: String(sqlite.prepare("SELECT access_status FROM service_media_assets WHERE id=?").get(prepared.body.data.mediaId).access_status) },
    { scan: "pending", access: "pending_upload" }, "no driver attempt advanced the media");
  assert.equal(String(sqlite.prepare("SELECT status FROM taxi_incidents WHERE id=?").get(reported.body.data.incidentId).status), "open");

  // THE CUSTOMER may acknowledge and read with the customer scope, and may do nothing else.
  const acknowledged = await post(customer, { bookingId, action: "acknowledge_incident", idempotencyKey: nextKey("route"), incidentId: reported.body.data.incidentId });
  assert.equal(acknowledged.status, 200, `the owning customer must be able to acknowledge: ${JSON.stringify(acknowledged)}`);
  for (const action of ["prepare_media", "record_location_sample", "report_incident", "record_media_scan"]) {
    const attempt = await post(customer, { bookingId, action, idempotencyKey: nextKey("route"), ...prepareInput(), latitude: 12, longitude: 77, accuracyMeters: 10, severity: "urgent", summary: "customer-reported incident", mediaRef: prepared.body.data.mediaRef, scanResult: "clean" });
    assert.ok([401, 403].includes(attempt.status), `a customer must not ${action}: ${JSON.stringify(attempt)}`);
  }
  // ANOTHER customer, with an equally valid session, cannot acknowledge this booking's incident.
  const otherCustomer = await customerSessionCookie(db, { principalKey: "+919800000099", customerId: "CUST-TAXI-STRANGER" });
  const strangerAck = await post(otherCustomer, { bookingId, action: "acknowledge_incident", idempotencyKey: nextKey("route"), incidentId: reported.body.data.incidentId });
  assert.ok([401, 403].includes(strangerAck.status), `a different customer must not acknowledge: ${JSON.stringify(strangerAck)}`);

  const customerRead = await get(customer, `bookingId=${bookingId}&scope=customer`);
  assert.equal(customerRead.status, 200);
  assert.equal(customerRead.body.scope, "customer");
  assert.equal(customerRead.body.data.sandboxOnly, true);

  // STAFF holding bookings.manage can finalize and scan; a support role that only views cannot.
  const finalized = await post({ staff: OPS_STAFF }, { bookingId, action: "sandbox_finalize_media", idempotencyKey: nextKey("route"), uploadToken: prepared.body.data.upload.token, storageObjectId: `objects/${prepared.body.data.mediaId}` });
  assert.equal(finalized.status, 200, `${JSON.stringify(finalized)}`);
  assert.equal((await post({ staff: SUPPORT }, { bookingId, action: "record_media_scan", idempotencyKey: nextKey("route"), mediaRef: prepared.body.data.mediaRef, scanResult: "clean" })).status, 403,
    "viewing bookings is not managing them");
  const scanned = await post({ staff: OPS_STAFF }, { bookingId, action: "record_media_scan", idempotencyKey: nextKey("route"), mediaRef: prepared.body.data.mediaRef, scanResult: "clean", actorId: `provider:${providerId}` });
  assert.equal(scanned.status, 200, `${JSON.stringify(scanned)}`);
  assert.equal(scanned.body.data.proofReady, true);
  // The scan approver on the record is the authenticated operator, not the body's claim — which also
  // means the body cannot be used to route around the "submitter cannot approve" guard.
  assert.equal(String(sqlite.prepare("SELECT actor_id FROM service_media_events WHERE media_id=? AND event_type='taxi_scan_passed'").get(prepared.body.data.mediaId).actor_id), OPS_STAFF);

  // An unknown action is a 400, and an anonymous caller reaches nothing at all.
  assert.equal((await post({ staff: OPS_STAFF }, { bookingId, action: "delete_everything", idempotencyKey: nextKey("route") })).status, 400);
  assert.ok([401, 403].includes((await post({}, { bookingId, action: "prepare_media", idempotencyKey: nextKey("route"), ...prepareInput() })).status));
  assert.ok([401, 403].includes((await get({}, `bookingId=${bookingId}`)).status));
});

// ---------------------------------------------------------------------------------------------
test("Gate 4: every proof action is idempotent per key and audited", async () => {
  const world = await proofWorld();
  const { sqlite, db, bookingId } = world;

  // ONE key, ONE effect. A retried driver tap must not produce a second grant or a second sample.
  const grantKey = nextKey("grant");
  const first = await mutate(db, bookingId, "prepare_media", { ...prepareInput(), key: grantKey });
  const replay = await mutate(db, bookingId, "prepare_media", { ...prepareInput(), key: grantKey });
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(replay.mediaId, first.mediaId, "the same key returns the same media");
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM service_media_assets").get().c), 1);
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM taxi_media_upload_grants").get().c), 1);

  const sampleKey = nextKey("sample");
  await mutate(db, bookingId, "record_location_sample", { latitude: 12.97, longitude: 77.59, accuracyMeters: 10, key: sampleKey });
  const sampleReplay = await mutate(db, bookingId, "record_location_sample", { latitude: 12.99, longitude: 77.61, accuracyMeters: 10, key: sampleKey });
  assert.equal(sampleReplay.duplicatePrevented, true);
  assert.equal(routeSamples(sqlite, bookingId).length, 1, "a replayed key records no second sample");
  assert.equal(JSON.parse(String(routeSamples(sqlite, bookingId)[0].detail_json)).latitude, 12.97,
    "and the replay's different coordinates are ignored rather than overwriting the first");

  const incidentKey = nextKey("incident");
  const incident = await mutate(db, bookingId, "report_incident", { severity: "urgent", summary: "pet distressed in traffic", key: incidentKey });
  const incidentReplay = await mutate(db, bookingId, "report_incident", { severity: "emergency", summary: "escalating the same event", key: incidentKey });
  assert.equal(incidentReplay.duplicatePrevented, true);
  assert.equal(incidentReplay.incidentId, incident.incidentId);
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM taxi_incidents").get().c), 1, "one tap, one incident");
  assert.equal(String(sqlite.prepare("SELECT severity FROM taxi_incidents WHERE id=?").get(incident.incidentId).severity), "urgent",
    "and a replay cannot escalate the severity of the incident it duplicates");

  // A missing booking, action or key is refused before anything is written.
  for (const bad of [{ bookingId: "" }, { action: "" }, { idempotencyKey: "" }]) {
    const attempt = await refusal(proof.mutateTaxiProof(db, { bookingId, action: "record_location_sample", actorId: DRIVER_ACTOR, idempotencyKey: nextKey("bad"), latitude: 12, longitude: 77, accuracyMeters: 10, ...bad }));
    assert.equal(attempt?.status, 400, `${JSON.stringify(bad)} must be refused`);
  }
  // A booking that is not a Pet Taxi booking is not reachable through this module at all.
  const notTaxi = seedCanonicalTrip(sqlite, { bookingId: "BKG-GROOM-1", tripId: "TRIP-GROOM", reservationId: "RES-GROOM", groupId: "GRP-GROOM", customerId: "CUST-GROOM" });
  sqlite.prepare("UPDATE canonical_bookings SET service_code='grooming' WHERE id=?").run(notTaxi.bookingId);
  assert.equal((await refusal(mutate(db, notTaxi.bookingId, "record_location_sample", { latitude: 12, longitude: 77, accuracyMeters: 10 })))?.status, 404);

  // Every incident transition is journalled with its actor, so the trail names who did what.
  await mutate(db, bookingId, "acknowledge_incident", { actorId: "customer:CUST-ACK", incidentId: incident.incidentId });
  await mutate(db, bookingId, "resolve_incident", { actorId: OPS_STAFF, incidentId: incident.incidentId, resolution: "driver stopped and checked the pet" });
  const trail = sqlite.prepare("SELECT event_type,actor_id FROM taxi_incident_events WHERE incident_id=? ORDER BY created_at").all(incident.incidentId);
  assert.deepEqual(trail.map((row) => [String(row.event_type), String(row.actor_id)]),
    [["reported", DRIVER_ACTOR], ["customer_acknowledged", "customer:CUST-ACK"], ["resolved", OPS_STAFF]]);
});
