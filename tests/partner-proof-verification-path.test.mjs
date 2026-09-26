/**
 * PARTNER-02 / PARTNER-04 — a partner's Boarding, Pet Sitting or Pet Taxi proof photo can become usable
 * (clean) through the product, and an incident is never lost behind an unverified photo. EXECUTED.
 *
 * THE DEFECT. prepare_media handed the partner a single-use upload token and nothing ever used it: the
 * only step off access_status='pending_upload' was the staff-only sandbox_finalize_media, which needs
 * that token, and no staff screen listed Boarding/Sitting/Taxi photos to verify. Every photo stayed
 * "awaiting upload confirmation", no proof_daily_update could be recorded, and no Boarding stay could be
 * checked out. The proof pages also attached that unscanned photo to incidents, which then 409'd.
 *
 * WHAT IS DRIVEN HERE. The same client functions the pages call (captureBoardingProof, the BCC's
 * loadPartnerProofForReview / recordPartnerProofDecision), with fetch routed to the REAL route handlers
 * on a real SQLite-backed D1, under a real partner session and a real staff identity. Requests go to a
 * non-preview origin so every authority separation is real rather than a preview superuser's.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installWorkersHooks, enterWorkersDbScope } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1, nextKey, seedBoardingStay, seedSittingBooking, validCarePlan, customerSessionCookie, OPS_ORIGIN } from "./helpers/stay-harness.mjs";
import { seedCanonicalTrip } from "./helpers/taxi-harness.mjs";

installWorkersHooks("__PARTNER02_DB__", "__PARTNER02_ENV__");

const lifecycle = await import("../lib/boarding-stay-lifecycle.ts");
const boardingProof = await import("../lib/boarding-proof-governance.ts");
const sittingProof = await import("../lib/sitting-proof-governance.ts");
const taxiProof = await import("../lib/taxi-proof-governance.ts");
const boardingClient = await import("../lib/boarding-proof-client.ts");
const sittingClient = await import("../lib/sitting-proof-client.ts");
const taxiClient = await import("../lib/taxi-proof-client.ts");
const partnerClient = await import("../lib/partner-proof-client.ts");
const ROUTES = {
  "/api/boarding-proof": await import("../app/api/boarding-proof/route.ts"),
  "/api/boarding-stays": await import("../app/api/boarding-stays/route.ts"),
  "/api/sitting-proof": await import("../app/api/sitting-proof/route.ts"),
  "/api/taxi-proof": await import("../app/api/taxi-proof/route.ts"),
  "/api/service-media": await import("../app/api/service-media/route.ts"),
};

const HOST = "host_maya_rohan";
const OPS = "ops.verifier@pawspace.test";
// A fixed service clock at 12:00 IST, so the stay day the milestones are counted against is certain.
const CLOCK = Date.UTC(2031, 2, 12, 6, 30);
const STAY_DAY = "2031-03-12";
const WINDOW = { scheduledStart: new Date(CLOCK - 3_600_000).toISOString(), scheduledEnd: new Date(CLOCK + 7_200_000).toISOString() };
const ENV = {
  NODE_ENV: "test", FORBID_PRODUCTION: "true", PAWSPACE_SCHEDULING_ENV: "uat", PAWSPACE_UAT_SERVICE_CLOCK: "on",
  PAWSPACE_UAT_EXECUTION_NOW_MS: String(CLOCK), PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_PAYMENT_LIVE_APPROVED: "false",
};

const photo = (seed = "bruno-garden") => new File([new TextEncoder().encode(`JPEG:${seed}:${"x".repeat(512)}`)], `${seed}.jpg`, { type: "image/jpeg" });

async function world() {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  enterWorkersDbScope(db);
  globalThis.__PARTNER02_DB__ = db;
  globalThis.__PARTNER02_ENV__ = { ...ENV };
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)").run("U-P02-OPS", OPS, "Ops Verifier", "admin", now, now);
  return { sqlite, db };
}

/**
 * Every fetch the client code makes is answered by the real route handler, as `session`. The origin is
 * the page's own, as a browser's same-origin request would carry it.
 */
async function as(session, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), OPS_ORIGIN);
    const route = ROUTES[url.pathname];
    if (!route) throw new Error(`the page called an unexpected endpoint: ${url.pathname}`);
    const headers = new Headers(init.headers);
    headers.set("origin", OPS_ORIGIN);
    if (session.cookie) headers.set("cookie", session.cookie);
    if (session.staff) headers.set("oai-authenticated-user-email", session.staff);
    const method = String(init.method || "GET").toUpperCase();
    return route[method](new Request(url, { method, headers, body: init.body }));
  };
  try { return await fn(); } finally { globalThis.fetch = original; }
}
const failure = async (promise) => { try { await promise; return null; } catch (error) { return error; } };
const staff = { staff: OPS };

/** A Boarding stay checked in through the real lifecycle, with the host signed in as a partner. */
async function boardingStay() {
  const w = await world();
  const seeded = await seedBoardingStay(w.db, w.sqlite, { window: WINDOW });
  const stay = (action, extra = {}) => lifecycle.mutateBoardingStay(w.db, { stayId: seeded.stayId, action, actorId: HOST, idempotencyKey: nextKey("P02-STAY"), ...extra });
  await stay("accept");
  await stay("submit_care_plan", { carePlan: validCarePlan(), actorId: seeded.customerId });
  await stay("check_in");
  const host = await customerSessionCookie(w.db, { principalKey: "+919700000202", customerId: HOST, subjectType: "provider" });
  return { ...w, ...seeded, stay, host };
}

const asset = (sqlite, mediaId) => sqlite.prepare("SELECT * FROM service_media_assets WHERE id=?").get(mediaId);

// ---------------------------------------------------------------------------------------------
test("PARTNER-02: a host's Boarding photo is uploaded by the proof page, verified by staff in the BCC, and the stay then checks out", async () => {
  const w = await boardingStay();

  // THE PARTNER PAGE'S CALL SEQUENCE: prepare, then upload the bytes with the token it just received.
  const captured = await as(w.host, () => boardingClient.captureBoardingProof({ stayId: w.stayId, purpose: "stay_update", file: photo() }));
  assert.equal(captured.status, "quarantined", `the upload must complete: ${JSON.stringify(captured)}`);
  assert.equal(captured.proofReady, false, "an uploaded photo is not proof until someone else verifies it");
  assert.equal(captured.objectStored, false, "with no bucket bound the response says honestly that only the checksum was kept");
  const uploaded = asset(w.sqlite, captured.mediaId);
  assert.deepEqual({ access: uploaded.access_status, scan: uploaded.scan_status, stored: uploaded.object_stored }, { access: "quarantined", scan: "pending", stored: 0 });
  assert.match(String(uploaded.storage_key), /^boarding\/object\//, "the server chose the storage key; no caller-supplied object id or URL");
  assert.equal(String(uploaded.created_by), `provider:${HOST}`, "the submitter on record is the signed-in host");

  // The listing the defect report read now says the photo is waiting for a decision, and which service it is.
  const listing = await as(staff, async () => (await fetch(`/api/service-media?bookingId=${w.bookingId}`)).json());
  assert.equal(listing.serviceCode, "boarding");
  assert.equal(listing.assets.find((item) => item.id === captured.mediaId)?.proofState, "awaiting_verification");

  // Not proof yet: the daily update is refused and check-out still names the missing photo.
  const early = await failure(as(w.host, () => boardingClient.updateBoardingProof({ stayId: w.stayId, action: "record_daily_update", idempotencyKey: nextKey("P02"), mediaRef: captured.mediaRef, note: "Bruno ate and played" })));
  assert.ok(early, "an unverified photo must not satisfy the daily update");
  await w.stay("care_event", { careEventType: "meal", detail: { stayDate: STAY_DAY } });
  await w.stay("care_event", { careEventType: "play", detail: { stayDate: STAY_DAY } });
  const blocked = await failure(w.stay("check_out"));
  assert.ok(blocked instanceof Response && blocked.status === 409);
  assert.match(await blocked.text(), new RegExp(`${STAY_DAY}:media`), "check-out is blocked by exactly the missing verified photo");

  // The host cannot decide on their own photo, through either staff action.
  for (const action of ["record_media_scan", "sandbox_finalize_media"]) {
    const self = await failure(as(w.host, () => boardingClient.updateBoardingProof({ stayId: w.stayId, action, idempotencyKey: nextKey("P02"), mediaRef: captured.mediaRef, scanResult: "clean", uploadToken: "x", storageObjectId: "boarding/objects/self-approve" })));
    assert.ok(self, `${action} must stay staff-only`);
  }
  assert.equal(asset(w.sqlite, captured.mediaId).scan_status, "pending");

  // THE STAFF SIDE: the BCC panel's own read and decision.
  const review = await as(staff, () => partnerClient.loadPartnerProofForReview("boarding", w.bookingId));
  assert.equal(review.scopeId, w.stayId, "the panel finds the stay behind the booking");
  const pending = review.media.find((item) => item.id === captured.mediaId);
  assert.equal(partnerClient.partnerProofState(pending), "awaiting_verification", "the panel offers the decision for exactly this photo");
  const decided = await as(staff, () => partnerClient.recordPartnerProofDecision("boarding", { scopeId: review.scopeId, mediaId: captured.mediaId, scanResult: "clean", reason: "Photo shows Bruno fed and settled" }));
  assert.equal(decided.proofReady, true);
  assert.equal(String(w.sqlite.prepare("SELECT actor_id FROM service_media_events WHERE media_id=? AND event_type='boarding_scan_passed'").get(captured.mediaId).actor_id), OPS, "the verifier on record is the staff member");
  const reviewed = await as(staff, () => partnerClient.loadPartnerProofForReview("boarding", w.bookingId));
  assert.equal(partnerClient.partnerProofState(reviewed.media.find((item) => item.id === captured.mediaId)), "verified");

  // The host records the daily update with the verified photo, and the stay checks out.
  const daily = await as(w.host, () => boardingClient.updateBoardingProof({ stayId: w.stayId, action: "record_daily_update", idempotencyKey: nextKey("P02"), mediaRef: captured.mediaRef, note: "Bruno ate well and played in the garden" }));
  assert.equal(daily.eventType, "proof_daily_update");
  assert.equal(daily.stayDate, STAY_DAY);
  const out = await w.stay("check_out");
  assert.equal(out.status, "completed", `check-out must succeed once the milestone is met: ${JSON.stringify(out)}`);
  assert.deepEqual({ ...w.sqlite.prepare("SELECT status,check_out_status FROM boarding_stays WHERE id=?").get(w.stayId) }, { status: "completed", check_out_status: "complete" });
});

// ---------------------------------------------------------------------------------------------
test("PARTNER-02: the partner upload is measured against the declaration, single-use and owner-only", async () => {
  const w = await boardingStay();
  const file = photo("declared");
  const sha256 = await partnerClient.proofFileSha256(file);
  const prepared = await as(w.host, () => boardingClient.updateBoardingProof({ stayId: w.stayId, action: "prepare_media", idempotencyKey: nextKey("P02"), purpose: "stay_update", mimeType: file.type, sizeBytes: file.size, sha256 }));
  const put = (session, body, token = prepared.upload.token, type = "image/jpeg") => as(session, () => fetch(`/api/boarding-proof?stayId=${w.stayId}`, { method: "PUT", headers: { "content-type": type, "x-pawspace-media-id": prepared.mediaId, "x-pawspace-upload-token": token }, body }));

  // Different bytes of the same size: the server's own digest refuses them, and nothing moves.
  const swapped = await put(w.host, photo("substitu"));
  assert.equal(swapped.status, 409);
  assert.equal((await swapped.json()).code, "object_checksum_mismatch", "the refusal says why");
  const wrongType = await put(w.host, file, prepared.upload.token, "image/png");
  assert.equal(wrongType.status, 409);
  const forged = await put(w.host, file, `${prepared.upload.token.split(".")[0]}.forged`);
  assert.equal(forged.status, 403);
  assert.equal(asset(w.sqlite, prepared.mediaId).access_status, "pending_upload", "no refused upload advanced the asset");

  // Another partner, with an equally valid session, cannot upload into this stay.
  const stranger = await customerSessionCookie(w.db, { principalKey: "+919700000299", customerId: "host_arjun_tara", subjectType: "provider" });
  assert.ok([401, 403].includes((await put(stranger, file)).status));

  // The genuine bytes are accepted once; the token cannot be replayed.
  assert.equal((await put(w.host, file)).status, 200);
  assert.equal(asset(w.sqlite, prepared.mediaId).access_status, "quarantined");
  assert.equal((await put(w.host, file)).status, 409, "a consumed grant is refused");
  const events = w.sqlite.prepare("SELECT event_type FROM service_media_events WHERE media_id=? ORDER BY created_at").all(prepared.mediaId).map((row) => row.event_type);
  assert.deepEqual(events, ["boarding_upload_grant_issued", "boarding_upload_received"]);
});

// ---------------------------------------------------------------------------------------------
test("PARTNER-04: an incident is recorded without an unverified photo, a direct attach says why, and a verified photo attaches", async () => {
  const w = await boardingStay();
  const pending = await as(w.host, () => boardingClient.captureBoardingProof({ stayId: w.stayId, purpose: "boarding_incident", file: photo("scratch") }));

  // What the proof page now sends: only a VERIFIED incident photo is attached, so this report has none.
  const snapshot = await as(w.host, () => boardingClient.loadBoardingProof(w.stayId));
  const attachable = snapshot.media.filter((item) => item.purpose === "boarding_incident" && partnerClient.isVerifiedProof(item));
  assert.equal(attachable.length, 0, "an uploaded but unverified photo is not offered for attachment");
  const reported = await as(w.host, () => boardingClient.updateBoardingProof({ stayId: w.stayId, action: "report_incident", idempotencyKey: nextKey("P02"), severity: "urgent", summary: "Minor scratch during play", actionTaken: "Cleaned and monitored", mediaRef: attachable[0]?.ref }));
  assert.ok(reported.incidentId, "the incident is recorded instead of failing on the photo");

  // A caller that still attaches the unverified photo is refused with a reason, not a generic 409.
  const direct = await as(w.host, () => fetch("/api/boarding-proof", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stayId: w.stayId, action: "report_incident", idempotencyKey: nextKey("P02"), severity: "attention", summary: "Second note on the scratch", mediaRef: pending.mediaRef }) }));
  assert.equal(direct.status, 409);
  const body = await direct.json();
  assert.equal(body.code, "incident_media_not_verified");
  assert.match(body.error, /has not passed scan review/);
  assert.match(body.error, /Report it without this photo/);

  // Once staff verify it, the same photo attaches.
  await as(staff, () => partnerClient.recordPartnerProofDecision("boarding", { scopeId: w.stayId, mediaId: pending.mediaId, scanResult: "clean", reason: "Scratch visible, pet calm" }));
  const withPhoto = await as(w.host, () => boardingClient.updateBoardingProof({ stayId: w.stayId, action: "report_incident", idempotencyKey: nextKey("P02"), severity: "attention", summary: "Follow-up photo of the scratch", mediaRef: pending.mediaRef }));
  assert.equal(String(w.sqlite.prepare("SELECT media_id FROM boarding_incidents WHERE id=?").get(withPhoto.incidentId).media_id), pending.mediaId);
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) n FROM boarding_incidents WHERE stay_id=?").get(w.stayId).n), 2, "the refused attach wrote no incident");
});

// ---------------------------------------------------------------------------------------------
test("PARTNER-02: a sitter's photo becomes verified Sitting proof through the page and the BCC", async () => {
  const w = await world();
  const seeded = await seedSittingBooking(w.db, w.sqlite, { status: "in_progress" });
  await sittingProof.ensureSittingProofTables(w.db);
  const sitter = await customerSessionCookie(w.db, { principalKey: "+919700000203", customerId: seeded.providerId, subjectType: "provider" });

  const captured = await as(sitter, () => sittingClient.captureSittingProof({ bookingId: seeded.bookingId, purpose: "sitting_update", file: photo("sitting") }));
  assert.equal(captured.status, "quarantined");
  assert.match(captured.mediaId, /^SMEDIA-/);
  const refused = await failure(as(sitter, () => sittingClient.updateSittingProof({ bookingId: seeded.bookingId, action: "record_update", idempotencyKey: nextKey("P02"), mediaRef: captured.mediaRef, note: "Fed and walked" })));
  assert.ok(refused, "an unverified photo is not Sitting proof");

  const review = await as(staff, () => partnerClient.loadPartnerProofForReview("pet_sitting", seeded.bookingId));
  assert.equal(partnerClient.partnerProofState(review.media.find((item) => item.id === captured.mediaId)), "awaiting_verification");
  const decided = await as(staff, () => partnerClient.recordPartnerProofDecision("pet_sitting", { scopeId: review.scopeId, mediaId: captured.mediaId, scanResult: "clean", reason: "Pet fed, bowl visible" }));
  assert.equal(decided.proofReady, true);
  const recorded = await as(sitter, () => sittingClient.updateSittingProof({ bookingId: seeded.bookingId, action: "record_update", idempotencyKey: nextKey("P02"), mediaRef: captured.mediaRef, note: "Fed and walked" }));
  assert.equal(recorded.status, "recorded");
});

// ---------------------------------------------------------------------------------------------
test("PARTNER-02: a driver's photo becomes verified Pet Taxi proof through the page and the BCC, and a rejection is final", async () => {
  const w = await world();
  const trip = seedCanonicalTrip(w.sqlite, { tripStatus: "in_progress", workOrderStatus: "accepted", offerStatus: "accepted", vehicleId: "VEH-1" });
  w.sqlite.prepare("UPDATE canonical_bookings SET status='in_progress' WHERE id=?").run(trip.bookingId);
  await taxiProof.ensureTaxiProofTables(w.db);
  const driver = await customerSessionCookie(w.db, { principalKey: "+919700000204", customerId: trip.providerId, subjectType: "provider" });

  const before = await as(driver, () => taxiClient.captureTaxiProof({ bookingId: trip.bookingId, purpose: "taxi_update", file: photo("loaded") }));
  const incident = await as(driver, () => taxiClient.captureTaxiProof({ bookingId: trip.bookingId, purpose: "taxi_incident", file: photo("unsettled") }));
  assert.match(before.mediaId, /^TMEDIA-/);

  const review = await as(staff, () => partnerClient.loadPartnerProofForReview("pet_taxi", trip.bookingId));
  assert.deepEqual(review.media.map((item) => partnerClient.partnerProofState(item)), ["awaiting_verification", "awaiting_verification"]);
  await as(staff, () => partnerClient.recordPartnerProofDecision("pet_taxi", { scopeId: trip.bookingId, mediaId: before.mediaId, scanResult: "clean", reason: "Pet secured in the carrier" }));
  await as(staff, () => partnerClient.recordPartnerProofDecision("pet_taxi", { scopeId: trip.bookingId, mediaId: incident.mediaId, scanResult: "rejected", reason: "Photo is of the road, not the pet" }));

  const update = await as(driver, () => taxiClient.updateTaxiProof({ bookingId: trip.bookingId, action: "record_photo_update", idempotencyKey: nextKey("P02"), mediaRef: before.mediaRef, note: "Pet loaded safely" }));
  assert.equal(update.canonicalRequirement, "Before Picture");
  const again = await failure(as(staff, () => partnerClient.recordPartnerProofDecision("pet_taxi", { scopeId: trip.bookingId, mediaId: incident.mediaId, scanResult: "clean", reason: "Changed my mind about it" })));
  assert.ok(again, "a rejected photo cannot be quietly re-passed");
  assert.equal(asset(w.sqlite, incident.mediaId).scan_status, "rejected");
});

// ---------------------------------------------------------------------------------------------
test("the BCC panel and the partner pages are wired to the governed path", () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const panel = read("app/booking-command-center/service-proof-review.tsx");
  assert.match(panel, /if \(isPartnerProofService\(partnerService\)\) return <PartnerProofReview bookingId=\{bookingId\} service=\{partnerService\} \/>;/, "Boarding, Sitting and Taxi bookings get their own verification panel");
  const partnerPanel = read("app/booking-command-center/partner-proof-review.tsx");
  assert.match(partnerPanel, /recordPartnerProofDecision\(service, \{ scopeId, mediaId: item\.id, scanResult, reason: reason\.trim\(\) \}\)/);
  assert.match(partnerPanel, /proofState === "awaiting_verification" &&/, "a decision is offered only for an uploaded photo awaiting it");
  assert.match(partnerPanel, /reason\.trim\(\)\.length < 5/, "a decision needs a reason");
  assert.match(read("lib/partner-proof-client.ts"), /action:"record_media_scan"/, "the decision is the service's own governed scan action");
  for (const [page, capture] of [["app/host/proof/page.tsx", "captureBoardingProof"], ["app/host/boarding-proof-workspace.tsx", "captureBoardingProof"], ["app/sitter/proof/page.tsx", "captureSittingProof"], ["app/driver/proof/page.tsx", "captureTaxiProof"]]) {
    const source = read(page);
    assert.match(source, new RegExp(`await ${capture}\\(`), `${page} uploads what it prepares`);
    assert.doesNotMatch(source, /action:"prepare_media"/, `${page} must not stop at prepare again`);
  }
  assert.match(read("app/host/proof/page.tsx"), /const mediaRef=verified\("boarding_incident"\)\.some\(item=>item\.ref===incidentRef\)\?incidentRef:undefined;/, "the host page attaches only a verified incident photo");
  assert.match(read("app/sitter/proof/page.tsx"), /const attached=verified\(mediaRef\)\?mediaRef:undefined;/, "the sitter page attaches only a verified incident photo");
  assert.match(read("app/driver/proof/page.tsx"), /const mediaRef=verified\("taxi_incident"\)\.some\(item=>String\(item\.mediaRef\)===incidentRef\)\?incidentRef:undefined;/, "the driver page attaches only a verified incident photo");
  // The lib-level functions are the ones the routes call.
  assert.equal(typeof boardingProof.receiveBoardingMediaUpload, "function");
  assert.equal(typeof sittingProof.receiveSittingMediaUpload, "function");
  assert.equal(typeof taxiProof.receiveTaxiMediaUpload, "function");
});
