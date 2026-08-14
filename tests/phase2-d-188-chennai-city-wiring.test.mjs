/**
 * FINDING #188 — the resolved city/zone is wired from the customer's address through scheduling to the
 * canonical booking, so an actual Chennai (maa) customer journey completes end-to-end AND Bengaluru
 * still works. Before the fix, every mobile-app flow baked the literal Bengaluru city/zone
 * ("blr"/"blr-east") into its reserveUatSchedule / createCanonicalLifecycle / commercial-quote calls,
 * SERVICE_ZONES had no Chennai zones, and seedProviderCapacityDefaults seeded no Chennai providers — so
 * a Chennai address resolved to not-serviceable, or (worse) a maa request could only ever be scheduled
 * against a Bengaluru pool. This suite drives the REAL route handlers with the payloads the FIXED flows
 * now produce (resolved location threaded through), on a non-localhost host with a real platform
 * session, over a real node:sqlite D1.
 *
 *   1. CHENNAI: a real Chennai pincode -> /api/service-zone resolves to a maa-* zone (city Chennai);
 *      reserveUatSchedule with cityId="maa" + that zone -> 200 with a MAA provider assigned; the
 *      persisted reservation is city_id='maa'; the canonical booking persists city_id='maa' with the
 *      maa zone. ZERO rows leak to 'blr' and the assigned provider is a maa provider.
 *   2. BENGALURU unchanged: the same journey with a blr pincode resolves blr-*, schedules a blr
 *      provider, persists city_id='blr' (no regression).
 *   3. FLOW SOURCE: the fixed mobile-app flows no longer emit a hardcoded blr/blr-east in their
 *      scheduling/booking calls — the city/zone comes from the resolved location.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__D188_DB__", "__D188_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

function freshDb(env = {}) {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__D188_DB__ = makeD1(sqlite);
  globalThis.__D188_ENV__ = env;
  return sqlite;
}

// Chennai has no +5:30 offset baked into the engine (cityOffsetMinutes only shifts 'blr'), so maa
// times are matched in UTC. BLR is +5:30, so 04:30Z = 10:00 IST. careMode 'overnight' opens a
// 00:00-23:59 roster window, matching the Sitting flow's overnight pet_sitting journey.
const MAA_START = "2026-09-01T09:30:00.000Z", MAA_END = "2026-09-01T17:30:00.000Z";
const BLR_START = "2026-09-01T04:30:00.000Z", BLR_END = "2026-09-01T12:30:00.000Z";

const schedulingRoute = await import("../app/api/uat-scheduling/route.ts");
const bookingRoute = await import("../app/api/canonical-bookings/route.ts");
const serviceZoneRoute = await import("../app/api/service-zone/route.ts");

const HOST = "https://app.pawspace.in";
const getServiceZone = (pincode) => serviceZoneRoute.GET(new Request(`${HOST}/api/service-zone?pincode=${encodeURIComponent(pincode)}`));
const postScheduling = (body) => schedulingRoute.POST(new Request(`${HOST}/api/uat-scheduling`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const postBooking = (cookie, body) => bookingRoute.POST(new Request(`${HOST}/api/canonical-bookings`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));

/** A real customer platform session (verified identity binding + issued cookie) — canonical-bookings
 *  POST calls requireCustomerOwnership, which on a non-localhost host demands a genuine session. */
async function customerCookie(db, customerId, principalKey) {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "customer_app", principalType: "phone", principalKey,
    subjectType: "customer", subjectId: customerId, verificationState: "verified",
    actorId: "test", reason: "#188 customer session",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: "customer_app", principalType: "phone",
    principalKey: String(binding.principal_key), subjectType: "customer", subjectId: customerId,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

// The exact payload shape the FIXED Pet Sitting flow now produces for the canonical booking — the only
// thing that varies per city is the resolved {cityId, zoneId} and provider (host-selected).
function sittingBookingBody(o) {
  return {
    idempotencyKey: o.idempotencyKey, scheduleGroupId: o.scheduleGroupId,
    customer: { id: o.customerId, name: "Customer", primaryPhone: o.phone },
    pets: [{ sourceId: "Bruno", name: "Bruno", species: "dog", vaccinationStatus: "not_provided" }],
    cityId: o.cityId, zoneId: o.zoneId,
    serviceCode: "pet_sitting", packageCode: "overnight-sitting", packageName: "Pet Sitting",
    scheduledStart: o.start, scheduledEnd: o.end,
    provider: { id: o.providerId, name: o.providerName, model: o.providerModel },
    totalAmount: 2400, amountDueNow: 2400,
    payment: { method: "upi", mode: "prepaid", status: "captured", detail: "UAT payment captured" },
    pricing: { discount: 0 },
  };
}

test("#188 CHENNAI: address(maa pincode) -> maa zone -> maa reservation -> maa canonical booking, zero blr leak", async () => {
  const sqlite = freshDb();

  // (1) The customer's address resolves to a Chennai zone — the single source of the journey location.
  const zoneRes = await getServiceZone("600028"); // R.A. Puram, Chennai
  const zoneBody = await zoneRes.json();
  assert.equal(zoneRes.status, 200, `a real Chennai pincode must resolve: ${JSON.stringify(zoneBody)}`);
  assert.equal(zoneBody.data.assignment.city, "Chennai", "resolves as a Chennai address");
  const zoneId = zoneBody.data.zone.zoneId;
  assert.equal(zoneId.slice(0, 3), "maa", "resolves to a Chennai (maa) zone, never a blr one");
  const cityId = zoneId.split("-")[0]; // exactly how the fixed flow derives cityId
  assert.equal(cityId, "maa");

  // (2) reserveUatSchedule with the resolved maa city/zone — a maa provider is assigned (Sitting is
  // host-selected, so the flow passes preferredProviderId; the seeded maa host offers pet_sitting).
  const schedRes = await postScheduling({
    clientRequestId: "D188-MAA-1", customerId: "CUS-MAA", petIds: ["Bruno"],
    serviceCode: "pet_sitting", cityId, zoneId, scheduledStart: MAA_START, scheduledEnd: MAA_END,
    careMode: "overnight", preferredProviderId: "host_maa_meena",
  });
  const sched = await schedRes.json();
  assert.equal(schedRes.status, 200, `maa reserve must succeed with a seeded Chennai provider: ${JSON.stringify(sched)}`);
  assert.equal(sched.data.provider.cityId, "maa", "the assigned provider is a Chennai provider");
  assert.notEqual(sched.data.provider.cityId, "blr", "no Bengaluru provider bleeds into a Chennai request");

  const reservation = sqlite.prepare("SELECT city_id,zone_id,provider_id FROM scheduling_reservations WHERE group_id=?").get("D188-MAA-1");
  assert.equal(reservation.city_id, "maa", "reservation persisted city_id='maa'");
  assert.equal(reservation.zone_id, zoneId);

  // (3) createCanonicalLifecycle / canonical booking persists the maa city + zone.
  const cookie = await customerCookie(globalThis.__D188_DB__, "CUS-MAA", "+919000000188");
  const bookRes = await postBooking(cookie, sittingBookingBody({
    idempotencyKey: "d188-maa-1", scheduleGroupId: "D188-MAA-1", customerId: "CUS-MAA", phone: "+919000000188",
    cityId, zoneId, start: MAA_START, end: MAA_END,
    providerId: sched.data.provider.id, providerName: sched.data.provider.name, providerModel: sched.data.provider.model,
  }));
  const book = await bookRes.json();
  assert.equal(bookRes.status, 201, `consistent Chennai booking must be accepted: ${JSON.stringify(book)}`);
  const booking = sqlite.prepare("SELECT city_id,zone_id,provider_id FROM canonical_bookings WHERE schedule_group_id=?").get("D188-MAA-1");
  assert.equal(booking.city_id, "maa", "canonical booking persisted city_id='maa'");
  assert.equal(booking.zone_id, zoneId, "canonical booking persisted the maa zone");

  // (4) NOTHING leaks to Bengaluru, and the provider is genuinely a maa provider (no cross-city pool).
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM scheduling_reservations WHERE city_id='blr'").get().c, 0, "no blr reservation for a Chennai journey");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM canonical_bookings WHERE city_id='blr'").get().c, 0, "no blr canonical booking for a Chennai journey");
  const providerCity = sqlite.prepare("SELECT city_id FROM provider_capacity_profiles WHERE id=?").get(booking.provider_id).city_id;
  assert.equal(providerCity, "maa", "the booked provider is a Chennai provider, not a cross-city Bengaluru one");
});

test("#188 BENGALURU unchanged: address(blr pincode) -> blr zone -> blr reservation -> blr canonical booking", async () => {
  const sqlite = freshDb();

  const zoneRes = await getServiceZone("560066"); // Whitefield -> blr-east (where the seeded blr sit host lives)
  const zoneBody = await zoneRes.json();
  assert.equal(zoneRes.status, 200);
  assert.equal(zoneBody.data.assignment.city, "Bengaluru");
  const zoneId = zoneBody.data.zone.zoneId, cityId = zoneId.split("-")[0];
  assert.equal(cityId, "blr");
  assert.equal(zoneId, "blr-east");

  const schedRes = await postScheduling({
    clientRequestId: "D188-BLR-1", customerId: "CUS-BLR", petIds: ["Bruno"],
    serviceCode: "pet_sitting", cityId, zoneId, scheduledStart: BLR_START, scheduledEnd: BLR_END,
    careMode: "overnight", preferredProviderId: "sit_sana",
  });
  const sched = await schedRes.json();
  assert.equal(schedRes.status, 200, `blr reserve must still succeed: ${JSON.stringify(sched)}`);
  assert.equal(sched.data.provider.cityId, "blr", "the assigned provider is a Bengaluru provider");

  const reservation = sqlite.prepare("SELECT city_id,zone_id FROM scheduling_reservations WHERE group_id=?").get("D188-BLR-1");
  assert.equal(reservation.city_id, "blr");
  assert.equal(reservation.zone_id, "blr-east");

  const cookie = await customerCookie(globalThis.__D188_DB__, "CUS-BLR", "+919000000189");
  const bookRes = await postBooking(cookie, sittingBookingBody({
    idempotencyKey: "d188-blr-1", scheduleGroupId: "D188-BLR-1", customerId: "CUS-BLR", phone: "+919000000189",
    cityId, zoneId, start: BLR_START, end: BLR_END,
    providerId: sched.data.provider.id, providerName: sched.data.provider.name, providerModel: sched.data.provider.model,
  }));
  const book = await bookRes.json();
  assert.equal(bookRes.status, 201, `consistent blr booking must be accepted: ${JSON.stringify(book)}`);
  const booking = sqlite.prepare("SELECT city_id,zone_id FROM canonical_bookings WHERE schedule_group_id=?").get("D188-BLR-1");
  assert.equal(booking.city_id, "blr", "Bengaluru journey still persists city_id='blr'");
  assert.equal(booking.zone_id, "blr-east");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM scheduling_reservations WHERE city_id='maa'").get().c, 0, "a blr journey creates no maa rows");
});

test("#188 FLOW SOURCE: fixed mobile-app flows carry the resolved location, not a hardcoded blr/blr-east, into scheduling/booking calls", () => {
  // The flows that reserve/book/quote must derive city+zone from the resolved location object; none may
  // still emit the literal Bengaluru city/zone in those calls (finding #2 / #188 no-fallback rule).
  const flows = ["grooming-flow.tsx", "stay-flow.tsx", "training-flow.tsx", "walking-flow.tsx", "taxi-flow.tsx", "food-flow.tsx"];
  for (const name of flows) {
    const src = fs.readFileSync(new URL(`../app/mobile-app/${name}`, import.meta.url), "utf8");
    assert.ok(src.includes("location.zoneId"), `${name} must pass the resolved zone (location.zoneId) into its calls`);
    assert.ok(src.includes("location.cityId"), `${name} must pass the resolved city (location.cityId) into its calls`);
    assert.equal(src.includes('zoneId:"blr-east"'), false, `${name} must not hardcode zoneId:"blr-east" in a scheduling/booking call`);
    assert.equal(src.includes('cityId:"blr"'), false, `${name} must not hardcode cityId:"blr" in a scheduling/booking call`);
  }
});
