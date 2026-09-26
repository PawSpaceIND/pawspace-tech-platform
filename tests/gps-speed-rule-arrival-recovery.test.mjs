/*
 * Owner decision, 26 Sept 2026 (work package G): one bad GPS fix must never block a groomer's arrival.
 *
 * The first M2 speed rule compared every new fix with the last trusted fix, however old, by device time. One bad
 * fix with a good reported accuracy - a stale wifi position, a fix at 0,0, a Playwright far point - became the
 * comparison point, and every correct fix after it was refused until (distance - accuracy) / 33 m/s had passed:
 * 150 s for 5 km, about 72 hours for 0,0. Meanwhile "Mark arrived" returned 409 quoting the bad fix's distance.
 *
 * Now: the comparison is only an accepted fix from the last 300 s; an isolated comparison fix is outvoted by three
 * consistent speed refusals spanning 30 s (audited as gps_baseline_reset); and the arrival refusal says the newest
 * fix was refused for speed. A comparison point corroborated by several accepted fixes is still never reset.
 *
 * These drive the real /api/grooming-route and /api/grooming-lifecycle handlers as the signed-in groomer, on the
 * in-memory harness with a controlled server clock. No network: fetch is disabled for the whole file.
 */
import { fixtureChecklist } from "./helpers/partner-checklist-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world } from "./helpers/execution-harness.mjs";

installWorkersHooks("__GPS_ARRIVAL_RESET_DB__", "__GPS_ARRIVAL_RESET_ENV__");
globalThis.fetch = async () => { throw new Error("network access is not allowed in this test"); };

const ORIGIN = "https://uat.pawspace.in", BOOKING = "BK-GPS-RESET", PROVIDER = "PRV-GPS-RESET";
const DOOR = { latitude: 12.9166, longitude: 77.6101 };
const north = (meters) => ({ latitude: DOOR.latitude + meters / 111_194.93, longitude: DOOR.longitude });

const realNow = Date.now;
let T0 = 0, clock = 0;
const at = (seconds) => { clock = T0 + seconds * 1000; };

async function providerCookie(db) {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "partner_otp", principalType: "identity_subject", principalKey: `provider:${PROVIDER}`,
    subjectType: "provider", subjectId: PROVIDER, verificationState: "verified", actorId: "gps-speed-rule-test", reason: "GPS speed rule journey",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: "partner_otp", principalType: "identity_subject",
    principalKey: String(binding.principal_key), subjectType: "provider", subjectId: PROVIDER,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

/** A confirmed Grooming booking at DOOR, accepted and on the way, with the staging GPS policy (300 s, 50 m). */
async function journey(t) {
  T0 = realNow(); clock = T0; Date.now = () => clock; t.after(() => { Date.now = realNow; });
  const { sqlite, db } = world("__GPS_ARRIVAL_RESET_DB__", "__GPS_ARRIVAL_RESET_ENV__", { PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_MAPS_ENV: "sandbox" });
  const now = Date.now();
  sqlite.exec(`
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_name TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,occurrence_count INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'assigned',assignment_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE booking_service_addresses (booking_id TEXT PRIMARY KEY,address TEXT NOT NULL,latitude REAL NOT NULL,longitude REAL NOT NULL,source TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
  `);
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  const { ensureGroomingMapTables } = await import("../lib/grooming-maps.ts");
  const { ensureUniversalLocationTables } = await import("../lib/universal-location-recovery.ts");
  await ensureSecurityTables(db);
  await ensureGroomingMapTables(db);
  await ensureUniversalLocationTables(db);
  sqlite.prepare("INSERT INTO booking_punctuality_policies (id,service_code,city_id,tracking_enabled,eta_freshness_seconds,allowed_accuracy_meters,approval_state,effective_from,effective_to,approved_by,updated_at) VALUES ('GPS-STAGING','grooming',NULL,1,300,50,'approved','2020-01-01',NULL,'test',?)").run(now);
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,total_amount,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'confirmed',1899,'customer:CUS-1',?,?)")
    .run(BOOKING, "ik-gps-reset", "CUS-1", "[\"PET-1\"]", "[\"SRC-1\"]", "blr", "blr-south", "grooming", "dog-basic", "Bath & Basic", "GRP-GPS-RESET", PROVIDER, "2026-09-26T04:30:00.000Z", "2026-09-26T06:30:00.000Z", now, now);
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES ('WO-GPS-RESET',?,'GRP-GPS-RESET',?,'Arun Groomer','full_time','grooming','2026-09-26T04:30:00.000Z','2026-09-26T06:30:00.000Z','assigned',?,?)").run(BOOKING, PROVIDER, now, now);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,method,mode,status,idempotency_key,created_at,updated_at) VALUES ('PAY-GPS-RESET',?,'CUS-1',1899,0,'cash','pay_after_service','created','pik-gps-reset',?,?)").run(BOOKING, now, now);
  sqlite.prepare("INSERT INTO booking_service_addresses (booking_id,address,latitude,longitude,source,created_at,updated_at) VALUES (?,?,?,?,'test_fixture',?,?)").run(BOOKING, "BTM Layout doorstep", DOOR.latitude, DOOR.longitude, now, now);
  sqlite.prepare("INSERT INTO booking_service_locations (booking_id,customer_id,provider_id,address_text,latitude,longitude,source,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'customer_verified_coordinates','active',?,?)").run(BOOKING, "CUS-1", PROVIDER, "BTM Layout doorstep", DOOR.latitude, DOOR.longitude, now, now);
  const cookie = await providerCookie(db);
  for (const action of ["accept", "on_the_way"]) {
    const step = await lifecycle(cookie, action);
    assert.equal(step.status, 200, `${action}: ${JSON.stringify(step.body)}`);
  }
  return { sqlite, db, cookie };
}

async function lifecycle(cookie, action) {
  const { POST } = await import("../app/api/grooming-lifecycle/route.ts");
  const response = await POST(new Request(`${ORIGIN}/api/grooming-lifecycle`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ bookingId: BOOKING, action, checklist: fixtureChecklist(action) }) }));
  return { status: response.status, body: await response.json() };
}

/** One fix from the groomer's phone, received at server second `seconds` (captured half a second earlier). */
async function fix(cookie, point, seconds, accuracy = 10) {
  at(seconds);
  const { POST } = await import("../app/api/grooming-route/route.ts");
  const response = await POST(new Request(`${ORIGIN}/api/grooming-route`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ bookingId: BOOKING, providerId: PROVIDER, latitude: point.latitude, longitude: point.longitude, accuracyMeters: accuracy, capturedAt: clock - 500 }) }));
  const body = await response.json();
  return { status: response.status, trustState: body.data?.providerLocation?.trustState, reason: body.data?.rejectionReason ?? null, eventId: body.data?.providerLocation?.eventId, body };
}
const resets = (sqlite) => sqlite.prepare("SELECT actor_email,detail_json FROM security_audit_events WHERE action='gps_baseline_reset' AND resource_id=?").all(BOOKING);

test("T1: a bad first fix 5 km away is outvoted by three steady doorstep fixes, and Mark arrived works at 45 s", async (t) => {
  const { sqlite, cookie } = await journey(t);
  const bad = await fix(cookie, north(5_000), 0, 20);
  assert.equal(bad.status, 201, "the first fix of a job is never speed-checked");
  const refused = [await fix(cookie, DOOR, 15), await fix(cookie, DOOR, 30)];
  assert.deepEqual(refused.map((r) => [r.status, r.reason]), [[422, "implausible_speed"], [422, "implausible_speed"]]);

  at(31);
  const early = await lifecycle(cookie, "arrived");
  assert.equal(early.status, 409);
  assert.equal(early.body.code, "arrival_latest_fix_rejected");
  assert.equal(early.body.reason, "implausible_speed");
  assert.match(early.body.error, /newest GPS fix was not accepted/);
  assert.doesNotMatch(early.body.error, /\d+ ?m from the customer doorstep|5000|4999/, "the refusal must not quote the bad fix's distance");
  assert.match(early.body.error, /usually within 30 seconds and at most about 5 minutes from now/, "the longest wait is what is left of the bad fix's 300 s window");

  const third = await fix(cookie, DOOR, 45);
  assert.equal(third.status, 201, `the third consistent fix resets the baseline: ${JSON.stringify(third.body)}`);
  const audit = resets(sqlite);
  assert.equal(audit.length, 1, "the reset is audited once");
  assert.equal(audit[0].actor_email, `provider:${PROVIDER}`);
  const detail = JSON.parse(audit[0].detail_json);
  assert.equal(detail.setAsideEventId, bad.eventId);
  assert.equal(detail.acceptedEventId, third.eventId);
  assert.deepEqual(detail.corroboratingEventIds, [refused[1].eventId, refused[0].eventId]);
  assert.equal(detail.spanSeconds, 30);
  assert.ok(Math.abs(detail.setAsideDistanceMeters - 5_000) <= 1, `the audit says how far off the set-aside fix was: ${detail.setAsideDistanceMeters}`);
  assert.doesNotMatch(audit[0].detail_json, /latitude|longitude|12\.9/, "no raw coordinates in the long-lived audit log; the location rows are purged on their own schedule");

  at(46);
  const arrived = await lifecycle(cookie, "arrived");
  assert.equal(arrived.status, 200, JSON.stringify(arrived.body));
  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(BOOKING).status, "arrived");
  assert.equal((await fix(cookie, DOOR, 60)).status, 201, "later doorstep fixes compare with the new baseline");
});

test("T2: a first fix at 0,0 no longer freezes the job for three days", async (t) => {
  const { sqlite, cookie } = await journey(t);
  assert.equal((await fix(cookie, { latitude: 0, longitude: 0 }, 0, 20)).status, 201);
  let acceptedAt = null;
  for (let s = 15; s <= 315 && acceptedAt === null; s += 15) if ((await fix(cookie, DOOR, s)).status === 201) acceptedAt = s;
  assert.ok(acceptedAt !== null && acceptedAt <= 315, `a doorstep fix must be accepted within 300 s plus one send interval (got ${acceptedAt})`);
  assert.equal(acceptedAt, 45);
  assert.equal(resets(sqlite).length, 1);
  at(acceptedAt + 1);
  assert.equal((await lifecycle(cookie, "arrived")).status, 200);
});

test("T3: a spoofed jump from a corroborated position is still refused, and arrival says why", async (t) => {
  const { sqlite, cookie } = await journey(t);
  for (const s of [0, 15, 30, 45, 60]) assert.equal((await fix(cookie, north(12_000), s)).status, 201, "home fixes, 12 km out");
  for (let s = 75; s <= 240; s += 15) {
    const jump = await fix(cookie, DOOR, s);
    assert.deepEqual([jump.status, jump.reason], [422, "implausible_speed"], `doorstep fix at ${s} s`);
  }
  assert.equal(resets(sqlite).length, 0, "a comparison point backed by other accepted fixes is never reset");
  at(241);
  const arrival = await lifecycle(cookie, "arrived");
  assert.equal(arrival.status, 409);
  assert.equal(arrival.body.code, "arrival_latest_fix_rejected");
  assert.match(arrival.body.error, /at most about 2 minutes from now/, "the newest home fix (60 s) leaves the 300 s window 119 s from now, so the partner is not promised 30 seconds");
  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(BOOKING).status, "on_the_way");
});

for (const gap of [301, 1_200]) {
  test(`T4: the first fix ${gap} s after the phone went quiet is accepted wherever it is`, async (t) => {
    const { sqlite, cookie } = await journey(t);
    assert.equal((await fix(cookie, north(12_000), 0)).status, 201);
    const doorstep = await fix(cookie, DOOR, gap);
    assert.equal(doorstep.status, 201, `nothing accepted in the last 300 s, so nothing to compare with: ${JSON.stringify(doorstep.body)}`);
    assert.equal(resets(sqlite).length, 0, "no reset was needed, so none is recorded");
    at(gap + 1);
    assert.equal((await lifecycle(cookie, "arrived")).status, 200);
  });
}

test("T8: the ordinary single doorstep fix still arrives, and a plain far fix still gets the distance refusal", async (t) => {
  const { cookie } = await journey(t);
  assert.equal((await fix(cookie, north(2_000), 0)).status, 201);
  at(1);
  const far = await lifecycle(cookie, "arrived");
  assert.equal(far.status, 409);
  assert.equal(far.body.code, "arrival_outside_geofence", "no fix was refused for speed, so the distance is the right answer");
  const doorstep = await fix(cookie, DOOR, 400);
  assert.equal(doorstep.status, 201);
  at(401);
  assert.equal((await lifecycle(cookie, "arrived")).status, 200);
});
