/**
 * LP-D02 and LP-D10 - two GET /api/provider-workspace projection defects.
 *
 * LP-D02: Earnings kept saying "Service proof still outstanding ... missing before photo, after photo"
 * for a grooming job whose two photos were approved and recorded, because pendingProof read the generic
 * provider_job_proofs staging table instead of grooming_service_proof, which is what grooming's
 * "Add service proof" (grooming-lifecycle add_proof) actually writes to.
 *
 * LP-D10: "PAYMENT PENDING" listed captured payments, because paymentPending's filter OR'd in ANY row
 * with paymentDueNow > 0 regardless of paymentStatus, even when the status was already 'captured'.
 *
 * Both live in the same providerWorkspace() projection (lib/provider-workspace.ts), run here against
 * real SQLite with the exact table DDL their real writers use.
 *
 * R2-P01 (round-2 partner due-lifecycle suite): LP-D02 again, for Boarding, Pet Sitting and Pet Taxi.
 * Their workflows record proof in their own event logs and never in provider_job_proofs, so Earnings
 * said "Service proof still outstanding … missing medication, food, daily_photo" for a stay the
 * lifecycle had just made prove itself. Those cases drive the REAL workflows, then read the projection.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { d1 } from "./helpers/execution-harness.mjs";
import { DatabaseSync } from "node:sqlite";
import {
  freshSqlite, makeD1, nextKey, seedBoardingStay, seedSittingBooking, seedDoorstep, metresNorth,
  validCarePlan, validSittingCarePlan, seedActiveCommercialTerm, seedCanonicalStayBooking,
} from "./helpers/stay-harness.mjs";
import { seedCanonicalTrip, seedVehicle } from "./helpers/taxi-harness.mjs";
import { atPickupTime } from "./helpers/taxi-pickup-time.mjs";

installWorkersHooks("__LPD02_DB__", "__LPD02_ENV__");

const PROVIDER = "PRV-GROOM-LPD02";
const now = Date.now();

function baseTables(sqlite) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,service_code TEXT,package_name TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,total_amount REAL,provider_id TEXT)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,status TEXT,method TEXT,mode TEXT)");
  // Exact DDL grooming-lifecycle's add_proof writes to (app/api/grooming-lifecycle/route.ts).
  sqlite.exec("CREATE TABLE IF NOT EXISTS grooming_service_proof (booking_id TEXT PRIMARY KEY,before_photo_ref TEXT,after_photo_ref TEXT,checklist_json TEXT NOT NULL DEFAULT '[]',completion_notes TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
}

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = d1(sqlite);
  globalThis.__LPD02_DB__ = db;
  globalThis.__LPD02_ENV__ = {};
  baseTables(sqlite);
  const capacity = await import("../lib/provider-capacity-governance.ts");
  const commission = await import("../lib/provider-commission-governance.ts");
  await capacity.ensureProviderCapacityTables(db);
  await commission.ensureProviderCommissionTables(db);
  sqlite.prepare("INSERT INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,effective_from,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(PROVIDER, "blr", "Groomer", "contract", JSON.stringify(["grooming"]), JSON.stringify(["koramangala"]), "2026-01-01", "ops.one@pawspace.in", now);
  const workspaceLib = await import("../lib/provider-workspace.ts");
  return { sqlite, db, workspaceLib };
}

function seedGroomingBooking(sqlite, { id, paymentStatus, dueNow, proof }) {
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,package_name,scheduled_start,scheduled_end,status,total_amount,provider_id) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, "CUS-1", "grooming", "Full Groom", "2026-08-01T04:00:00.000Z", "2026-08-01T05:00:00.000Z", "completed", 1299, PROVIDER);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,amount,amount_due_now,currency,status,method,mode) VALUES (?,?,?,?,?,?,?,?)")
    .run(`PAY-${id}`, id, 1299, dueNow, "INR", paymentStatus, "upi", "prepaid");
  if (proof) {
    sqlite.prepare("INSERT INTO grooming_service_proof (booking_id,before_photo_ref,after_photo_ref,checklist_json,completion_notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, proof.before ?? null, proof.after ?? null, "[]", null, now, now);
  }
}

test("LP-D02: a grooming job with both photos approved in grooming_service_proof is not reported as missing proof", async () => {
  const { sqlite, db, workspaceLib } = await world();
  seedGroomingBooking(sqlite, {
    id: "PS-UAT-MUBBSUG2-A32D", paymentStatus: "captured", dueNow: 0,
    proof: { before: "media://asset/MEDIA-BEFORE-1", after: "media://asset/MEDIA-AFTER-1" },
  });
  const workspace = await workspaceLib.providerWorkspace(db, { providerId: PROVIDER });
  assert.deepEqual(workspace.pendingProof, [], "both photos are recorded, so nothing should be outstanding");
});

test("LP-D02: a grooming job with only one photo recorded still reports the other as missing", async () => {
  const { sqlite, db, workspaceLib } = await world();
  seedGroomingBooking(sqlite, {
    id: "PS-UAT-ONE-PHOTO", paymentStatus: "captured", dueNow: 0,
    proof: { before: "media://asset/MEDIA-BEFORE-2", after: null },
  });
  const workspace = await workspaceLib.providerWorkspace(db, { providerId: PROVIDER });
  const entry = workspace.pendingProof.find(item => item.bookingId === "PS-UAT-ONE-PHOTO");
  assert.ok(entry, "the incomplete booking must still be flagged");
  assert.deepEqual(entry.missing, ["after_photo"]);
});

test("LP-D02: a grooming job with no service-proof row at all reports both photos missing", async () => {
  const { sqlite, db, workspaceLib } = await world();
  seedGroomingBooking(sqlite, { id: "PS-UAT-NO-PROOF", paymentStatus: "captured", dueNow: 0, proof: null });
  const workspace = await workspaceLib.providerWorkspace(db, { providerId: PROVIDER });
  const entry = workspace.pendingProof.find(item => item.bookingId === "PS-UAT-NO-PROOF");
  assert.ok(entry);
  assert.deepEqual(entry.missing.sort(), ["after_photo", "before_photo"]);
});

test("LP-D10: a captured payment does not appear in paymentPending even though amount_due_now still carries the booking's original amount", async () => {
  const { sqlite, db, workspaceLib } = await world();
  seedGroomingBooking(sqlite, {
    id: "PS-UAT-CAPTURED-1", paymentStatus: "captured", dueNow: 1299,
    proof: { before: "media://asset/A", after: "media://asset/B" },
  });
  const workspace = await workspaceLib.providerWorkspace(db, { providerId: PROVIDER });
  assert.ok(!workspace.bookings.paymentPending.some(item => item.bookingId === "PS-UAT-CAPTURED-1"),
    "a captured payment must never be listed as pending, regardless of stored amount_due_now");
  const booking = workspace.bookings.past.find(item => item.bookingId === "PS-UAT-CAPTURED-1");
  assert.equal(booking?.paymentStatus, "captured");
  assert.equal(booking?.paymentDueNow, 0, "every Partner workspace section must show the current settled balance, not the original instalment");
});



test("LP-D10: degraded balance snapshot falls back to the legacy workspace projection instead of failing the whole workspace", async () => {
  const { sqlite, db, workspaceLib } = await world();
  seedGroomingBooking(sqlite, { id: "PS-UAT-FALLBACK-1", paymentStatus: "pending", dueNow: 1299, proof: null });
  sqlite.exec("CREATE TABLE stay_payment_schedules (booking_id TEXT PRIMARY KEY)");
  const workspace = await workspaceLib.providerWorkspace(db, { providerId: PROVIDER });
  const booking = workspace.bookings.past.find(item => item.bookingId === "PS-UAT-FALLBACK-1");
  assert.equal(booking?.paymentStatus, "pending");
  assert.equal(booking?.paymentDueNow, 1299);
  assert.ok(workspace.bookings.paymentPending.some(item => item.bookingId === "PS-UAT-FALLBACK-1"));
});

test("LP-D10: an actually pending/partial/failed payment still appears in paymentPending", async () => {
  const { sqlite, db, workspaceLib } = await world();
  seedGroomingBooking(sqlite, { id: "PS-UAT-PARTIAL-1", paymentStatus: "partial", dueNow: 500, proof: null });
  seedGroomingBooking(sqlite, { id: "PS-UAT-PENDING-1", paymentStatus: "pending", dueNow: 1299, proof: null });
  const workspace = await workspaceLib.providerWorkspace(db, { providerId: PROVIDER });
  const pendingIds = workspace.bookings.paymentPending.map(item => item.bookingId).sort();
  assert.deepEqual(pendingIds, ["PS-UAT-PARTIAL-1", "PS-UAT-PENDING-1"]);
});

// ---------------------------------------------------------------------------------------------
// R2-P01: Boarding, Pet Sitting and Pet Taxi proof is read from each workflow's own records.
// ---------------------------------------------------------------------------------------------
const HOST = "host_maya_rohan", SITTER = "sitter_ananya", DRIVER = "taxi_rahul";
const REVIEWER = "ops.reviewer@pawspace.test";
const SHA = "a".repeat(64);
// A fixed service clock at 12:00 IST YESTERDAY: the stay day the Boarding milestones count against is
// certain, the job is already in the partner's past, and a medication given "at 12:00" is not in the future.
const STAY_DAY = new Date(Date.now() - 86_400_000 + 330 * 60_000).toISOString().slice(0, 10);
const CLOCK = Date.parse(`${STAY_DAY}T06:30:00.000Z`);
const LIVED_WINDOW = { scheduledStart: new Date(CLOCK - 3_600_000).toISOString(), scheduledEnd: new Date(CLOCK + 7_200_000).toISOString() };
const SERVICE_CLOCK_ENV = {
  NODE_ENV: "test", FORBID_PRODUCTION: "true", PAWSPACE_SCHEDULING_ENV: "uat", PAWSPACE_UAT_SERVICE_CLOCK: "on",
  PAWSPACE_UAT_EXECUTION_NOW_MS: String(CLOCK), PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_PAYMENT_LIVE_APPROVED: "false",
};

async function governedWorld(env = SERVICE_CLOCK_ENV) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__LPD02_DB__ = db;
  globalThis.__LPD02_ENV__ = { ...env };
  const workspaceLib = await import("../lib/provider-workspace.ts");
  const pendingFor = async (providerId, bookingId) => {
    const workspace = await workspaceLib.providerWorkspace(db, { providerId });
    assert.ok(workspace.bookings.past.some(item => item.bookingId === bookingId), `${bookingId} is on ${providerId}'s past jobs, so its proof is checked`);
    return workspace.pendingProof.find(item => item.bookingId === bookingId) ?? null;
  };
  return { sqlite, db, pendingFor };
}

/** A Boarding stay run by the host through the governed stay and proof workflows, then checked out. */
async function boardingStayRun(w, { carePlan = validCarePlan(), medicationEvidence = false, checkOut = true } = {}) {
  const lifecycle = await import("../lib/boarding-stay-lifecycle.ts");
  const proof = await import("../lib/boarding-proof-governance.ts");
  const seeded = await seedBoardingStay(w.db, w.sqlite, { window: LIVED_WINDOW });
  await proof.ensureBoardingProofTables(w.db);
  const stay = (action, extra = {}) => lifecycle.mutateBoardingStay(w.db, { stayId: seeded.stayId, action, actorId: HOST, idempotencyKey: nextKey("R2-STAY"), ...extra });
  const evidence = (action, extra = {}) => proof.mutateBoardingProof(w.db, { stayId: seeded.stayId, action, actorId: HOST, idempotencyKey: nextKey("R2-BPROOF"), ...extra });
  const verifiedPhoto = async (purpose) => {
    const grant = await evidence("prepare_media", { purpose, mimeType: "image/jpeg", sizeBytes: 240_000, sha256: SHA });
    await evidence("sandbox_finalize_media", { mediaRef: grant.mediaRef, uploadToken: grant.upload.token, storageObjectId: `boarding/objects/${nextKey("OBJ")}` });
    await evidence("record_media_scan", { mediaRef: grant.mediaRef, scanResult: "clean", actorId: REVIEWER });
    return grant.mediaRef;
  };
  await stay("accept");
  await stay("submit_care_plan", { carePlan, actorId: seeded.customerId });
  await stay("check_in");
  if (!checkOut) return seeded;
  await stay("care_event", { careEventType: "meal", detail: { stayDate: STAY_DAY } });
  await stay("care_event", { careEventType: "play", detail: { stayDate: STAY_DAY } });
  await evidence("record_daily_update", { mediaRef: await verifiedPhoto("stay_update"), note: "Bruno ate well and played in the garden" });
  if (medicationEvidence) await evidence("record_medication", { mediaRef: await verifiedPhoto("boarding_medication"), medicationName: "Apoquel", dose: "16 mg", administeredAt: new Date(CLOCK).toISOString() });
  const out = await stay("check_out");
  assert.equal(out.status, "completed", "the stay's own checkout gate accepted its proof");
  return seeded;
}

/** A Pet Sitting visit run by the sitter through the governed lifecycle and proof workflows, then checked out. */
async function sittingVisitRun(w, { meal = true, photo = true, carePlan = validSittingCarePlan(), onCheckedIn = null } = {}) {
  const lifecycle = await import("../lib/sitting-lifecycle.ts");
  const proof = await import("../lib/sitting-proof-governance.ts");
  const seeded = await seedSittingBooking(w.db, w.sqlite, { window: LIVED_WINDOW });
  const doorstep = seedDoorstep(w.sqlite, { bookingId: seeded.bookingId, customerId: seeded.customerId });
  await seedActiveCommercialTerm(w.db, { serviceCode: "pet_sitting" });
  await proof.ensureSittingProofTables(w.db);
  const act = (action, extra = {}) => lifecycle.mutateSittingBooking(w.db, { bookingId: seeded.bookingId, action, actorId: SITTER, idempotencyKey: nextKey("R2-SIT"), ...extra });
  const evidence = (action, extra = {}) => proof.mutateSittingProof(w.db, { bookingId: seeded.bookingId, action, actorId: SITTER, idempotencyKey: nextKey("R2-SPROOF"), ...extra });
  await act("accept");
  await act("submit_care_plan", { carePlan, actorId: seeded.customerId });
  await act("check_in", metresNorth(doorstep, 20));
  if (onCheckedIn) await onCheckedIn(evidence);
  if (meal) await act("care_event", { careEventType: "meal", detail: { message: "Dinner served" } });
  if (photo) {
    const grant = await evidence("prepare_media", { purpose: "sitting_update", mimeType: "image/jpeg", sizeBytes: 240_000, sha256: SHA });
    await evidence("sandbox_finalize_media", { uploadToken: grant.upload.token, storageObjectId: `sitting/objects/${nextKey("OBJ")}` });
    await evidence("record_media_scan", { mediaRef: grant.mediaRef, scanResult: "clean", actorId: REVIEWER });
    await evidence("record_update", { mediaRef: grant.mediaRef, note: "Fed, walked and settled" });
  }
  const out = await act("check_out");
  assert.equal(out.status, "completed");
  return seeded;
}

test("R2-P01: a Boarding stay checked out through its governed workflow is not reported as missing proof", async () => {
  const w = await governedWorld();
  const stay = await boardingStayRun(w);
  const recorded = w.sqlite.prepare("SELECT DISTINCT event_type FROM boarding_stay_events WHERE booking_id=?").all(stay.bookingId).map(row => row.event_type);
  for (const type of ["care_meal", "proof_daily_update"]) assert.ok(recorded.includes(type), `the stay workflow recorded ${type}`);
  assert.equal(await w.pendingFor(HOST, stay.bookingId), null,
    "the meal and the verified daily photo are on record, and the Care Card asks for no medication");
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM provider_job_proofs WHERE booking_id=?").get(stay.bookingId).n, 0,
    "and, as on staging, nothing ever reached provider_job_proofs");
});

test("R2-P01: a Boarding stay whose Care Card asks for medication is still flagged until medication is evidenced", async () => {
  const withoutEvidence = await governedWorld();
  const flagged = await boardingStayRun(withoutEvidence, { carePlan: validCarePlan({ medication: "Apoquel 16 mg with dinner" }) });
  assert.deepEqual((await withoutEvidence.pendingFor(HOST, flagged.bookingId))?.missing, ["medication"],
    "the stay checked out, but the medication its Care Card asked for was never evidenced");

  const withEvidence = await governedWorld();
  const evidenced = await boardingStayRun(withEvidence, { carePlan: validCarePlan({ medication: "Apoquel 16 mg with dinner" }), medicationEvidence: true });
  assert.equal(await withEvidence.pendingFor(HOST, evidenced.bookingId), null, "the governed medication record satisfies it");
});

test("R2-P01: a Boarding stay in progress without its milestones is still flagged", async () => {
  const w = await governedWorld();
  const stay = await boardingStayRun(w, { checkOut: false });
  assert.deepEqual((await w.pendingFor(HOST, stay.bookingId))?.missing, ["food", "daily_photo"]);
});

test("R2-P01: a Pet Sitting visit checked out with its meal and verified photo is not flagged; one without them is", async () => {
  const complete = await governedWorld();
  const visit = await sittingVisitRun(complete);
  assert.equal(await complete.pendingFor(SITTER, visit.bookingId), null);
  assert.equal(complete.sqlite.prepare("SELECT COUNT(*) n FROM provider_job_proofs WHERE booking_id=?").get(visit.bookingId).n, 0);

  const bare = await governedWorld();
  const skipped = await sittingVisitRun(bare, { meal: false, photo: false });
  assert.deepEqual((await bare.pendingFor(SITTER, skipped.bookingId))?.missing, ["food", "visit_photo"],
    "Sitting checkout does not gate on proof, so a visit closed without it is genuinely missing it");
});

test("R2-P01: a Sitting Care Card that says \"No medication\" owes no medication proof, and none can be recorded against it", async () => {
  const w = await governedWorld();
  const visit = await sittingVisitRun(w, {
    carePlan: validSittingCarePlan({ medication: "No medication" }),
    onCheckedIn: async (evidence) => {
      const grant = await evidence("prepare_media", { purpose: "sitting_medication", mimeType: "image/jpeg", sizeBytes: 240_000, sha256: SHA });
      await evidence("sandbox_finalize_media", { uploadToken: grant.upload.token, storageObjectId: `sitting/objects/${nextKey("OBJ")}` });
      await evidence("record_media_scan", { mediaRef: grant.mediaRef, scanResult: "clean", actorId: REVIEWER });
      const refused = await evidence("record_medication", { mediaRef: grant.mediaRef, medicationName: "Apoquel", dose: "16 mg", administeredAt: new Date(CLOCK).toISOString() }).then(() => null, error => error);
      assert.ok(refused instanceof Response && refused.status === 409, "the workflow refuses medication evidence against a Care Card that asks for none");
      assert.match(await refused.text(), /no medication instruction/);
    },
  });
  assert.equal(await w.pendingFor(SITTER, visit.bookingId), null, "so the projection does not demand it either");
});

test("R2-P01: a Pet Taxi trip completed through its governed lifecycle is not reported as missing proof", async () => {
  const w = await governedWorld({ PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_PAYMENT_LIVE_APPROVED: "false" });
  const taxi = await import("../lib/taxi-lifecycle.ts");
  const taxiProof = await import("../lib/taxi-proof-governance.ts");
  const trip = seedCanonicalTrip(w.sqlite, { providerId: DRIVER });
  await taxi.ensureTaxiLifecycleTables(w.db);
  await seedActiveCommercialTerm(w.db);
  const drive = async (action, extra = {}) => {
    if (action === "confirm_pickup") await atPickupTime(w.db, trip.bookingId);
    return taxi.mutateTaxiBooking(w.db, { bookingId: trip.bookingId, action, actorId: `driver:${DRIVER}`, idempotencyKey: nextKey(action), ...extra });
  };
  await drive("accept");
  await drive("assign_vehicle", { vehicleId: seedVehicle(w.sqlite, { providerId: DRIVER }) });
  await drive("confirm_pickup", { handoverMethod: "owner" });
  await drive("start_trip");
  for (const index of [1, 2]) {
    await taxiProof.mutateTaxiProof(w.db, { bookingId: trip.bookingId, action: "record_location_sample", actorId: `driver:${DRIVER}`, idempotencyKey: nextKey("sample"), latitude: 12.97 + index / 1000, longitude: 77.64 + index / 1000, accuracyMeters: 9 });
  }
  await drive("arrive_dropoff");
  await drive("confirm_dropoff");
  assert.equal((await drive("complete_trip")).status, "completed");
  assert.equal(await w.pendingFor(DRIVER, trip.bookingId), null, "arrival and completion are in the trip's own event log");
});

test("R2-P01: a Sitting or Boarding job its partner never started owes no proof", async () => {
  const w = await governedWorld({});
  const sitting = await import("../lib/sitting-lifecycle.ts");
  const stays = await import("../lib/boarding-stay-lifecycle.ts");
  const lapsed = { scheduledStart: new Date(Date.now() - 50 * 3_600_000).toISOString(), scheduledEnd: new Date(Date.now() - 48 * 3_600_000).toISOString() };
  const visit = await seedSittingBooking(w.db, w.sqlite, { window: lapsed, groupId: "GRP-SIT-LAPSED", reservationId: "RES-SIT-LAPSED" });
  await sitting.mutateSittingBooking(w.db, { bookingId: visit.bookingId, action: "accept", actorId: SITTER, idempotencyKey: nextKey("R2-ACC") });
  const stay = await seedBoardingStay(w.db, w.sqlite, { bookingId: "BKG-BOARD-LAPSED", window: lapsed });
  await stays.mutateBoardingStay(w.db, { stayId: stay.stayId, action: "accept", actorId: HOST, idempotencyKey: nextKey("R2-ACC") });
  assert.equal(w.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(visit.bookingId).status, "assigned");
  assert.equal(w.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(stay.bookingId).status, "assigned");
  // Accepted, window over, never checked in: the workflow could never have recorded a meal or a photo.
  assert.equal(await w.pendingFor(SITTER, visit.bookingId), null);
  assert.equal(await w.pendingFor(HOST, stay.bookingId), null);
});

test("R2-P01: Training still reads arrival and completion from its session log", async () => {
  const w = await governedWorld({});
  const training = await import("../lib/training-session-lifecycle.ts");
  await training.ensureTrainingSessionLifecycleTables(w.db);
  const past = { scheduledStart: new Date(Date.now() - 72 * 3_600_000).toISOString(), scheduledEnd: new Date(Date.now() - 71 * 3_600_000).toISOString() };
  const trainer = "trainer_kavya";
  const insert = w.sqlite.prepare("INSERT INTO training_session_events (id,session_id,programme_id,booking_id,event_type,actor_id,idempotency_key,detail_json,created_at) VALUES (?,?,?,?,?,?,?,'{}',?)");
  for (const [bookingId, events] of [["BKG-TRAIN-DONE", ["arrive", "complete"]], ["BKG-TRAIN-HALF", ["arrive"]]]) {
    seedCanonicalStayBooking(w.sqlite, { bookingId, providerId: trainer, serviceCode: "dog_training", packageCode: "starter", status: "completed", groupId: `GRP-${bookingId}`, reservationId: `RES-${bookingId}`, ...past });
    for (const type of events) insert.run(`EV-${bookingId}-${type}`, `S-${bookingId}`, `P-${bookingId}`, bookingId, type, trainer, `K-${bookingId}-${type}`, Date.now());
  }
  assert.equal(await w.pendingFor(trainer, "BKG-TRAIN-DONE"), null);
  assert.deepEqual((await w.pendingFor(trainer, "BKG-TRAIN-HALF"))?.missing, ["completed"]);
});
