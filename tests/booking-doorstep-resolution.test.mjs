import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

/**
 * lib/booking-doorstep.ts is the single doorstep resolver behind every arrival/start geofence (Grooming
 * ARRIVED, Training ARRIVED, Sitting check-in, Walking start). Two tables can hold a booking coordinate
 * and only one of them is written by a customer flow, so which one wins - and when neither may be used -
 * is a safety property, not a detail.
 */
function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { sqlite.prepare(sql).run(...args); return { success: true }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return { prepare: (sql) => statement(sql, []) };
}

// DDL copied from the owning sources: booking_service_locations from lib/grooming-maps.ts,
// booking_service_addresses from lib/provider-daily-travel.ts.
const LOCATIONS = "CREATE TABLE booking_service_locations (booking_id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,provider_id TEXT NOT NULL,address_text TEXT NOT NULL,latitude REAL,longitude REAL,source TEXT NOT NULL DEFAULT 'customer_booking',status TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)";
const ADDRESSES = "CREATE TABLE booking_service_addresses (booking_id TEXT PRIMARY KEY,address TEXT NOT NULL,latitude REAL,longitude REAL,source TEXT NOT NULL DEFAULT 'staff_entered',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)";

const { resolveBookingDoorstep } = await import("../lib/booking-doorstep.ts");
const NOW = Date.now();

function world({ locations = true, addresses = true } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  if (locations) sqlite.exec(LOCATIONS);
  if (addresses) sqlite.exec(ADDRESSES);
  const seedLocation = (bookingId, latitude, longitude, status = "active") =>
    sqlite.prepare("INSERT INTO booking_service_locations (booking_id,customer_id,provider_id,address_text,latitude,longitude,source,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'customer_booking',?,?,?)")
      .run(bookingId, "CUS-1", "PRV-1", "Customer set address", latitude, longitude, status, NOW, NOW);
  const seedTravelAddress = (bookingId, latitude, longitude) =>
    sqlite.prepare("INSERT INTO booking_service_addresses (booking_id,address,latitude,longitude,source,created_at,updated_at) VALUES (?,?,?,?,'staff_entered',?,?)")
      .run(bookingId, "Staff entered travel address", latitude, longitude, NOW, NOW);
  return { sqlite, db: makeD1(sqlite), seedLocation, seedTravelAddress };
}

test("the customer's active service location is the doorstep, not the travel address", async () => {
  const { db, seedLocation, seedTravelAddress } = world();
  seedLocation("BK-1", 12.9611, 77.6387);
  seedTravelAddress("BK-1", 13.2000, 77.9000);
  assert.deepEqual(await resolveBookingDoorstep(db, "BK-1"), { latitude: 12.9611, longitude: 77.6387, source: "booking_service_locations" });
});

test("an active location with no coordinates refuses rather than geofencing at an older address", async () => {
  // The whole point of the fallback is a booking the customer never set a location for. Once they HAVE
  // set one, a different address is the wrong doorstep even when it is the only one carrying coordinates:
  // the provider would be recorded as "at the doorstep" while standing somewhere the customer replaced.
  const { db, seedLocation, seedTravelAddress } = world();
  seedLocation("BK-1", null, null);
  seedTravelAddress("BK-1", 13.2000, 77.9000);
  assert.equal(await resolveBookingDoorstep(db, "BK-1"), null);
});

test("a superseded location does not keep geofencing, and the travel address is used when no active one exists", async () => {
  const { db, seedLocation, seedTravelAddress } = world();
  seedLocation("BK-1", 12.9611, 77.6387, "replaced");
  seedTravelAddress("BK-1", 13.2000, 77.9000);
  assert.deepEqual(await resolveBookingDoorstep(db, "BK-1"), { latitude: 13.2000, longitude: 77.9000, source: "booking_service_addresses" });
});

test("no coordinates anywhere resolves to null, and a missing table is not an error", async () => {
  const { db } = world();
  assert.equal(await resolveBookingDoorstep(db, "BK-UNKNOWN"), null);
  const noTables = world({ locations: false, addresses: false });
  assert.equal(await resolveBookingDoorstep(noTables.db, "BK-1"), null);
  const onlyTravel = world({ locations: false });
  onlyTravel.seedTravelAddress("BK-1", 12.9611, 77.6387);
  assert.deepEqual(await resolveBookingDoorstep(onlyTravel.db, "BK-1"), { latitude: 12.9611, longitude: 77.6387, source: "booking_service_addresses" });
});
