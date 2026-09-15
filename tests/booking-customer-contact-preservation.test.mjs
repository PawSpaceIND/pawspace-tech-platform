/*
 * CONFIRMED P0 data-loss defect: confirming ANY booking silently ERASED the customer's saved email
 * and their saved secondary ("Alternative") phone number.
 *
 * All six booking surfaces upsert canonical_customers in their write batch, and all six wrote the
 * conflict clause unconditionally:
 *
 *   ON CONFLICT(id) DO UPDATE SET ... secondary_phone=excluded.secondary_phone, email=excluded.email
 *
 * bound with `customer.secondaryPhone ?? null` and `customer.email ?? null`. No booking client sends
 * `email` at all, and step 4's "Alternative Phone Number" field is not pre-filled from the profile,
 * so BOTH arrive absent on a normal booking and the clause overwrote the stored values:
 *
 *   customer saves email + alternate phone in their profile  ->  both stored
 *   customer books anything                                  ->  email = NULL, secondary_phone = ""
 *   invoices, receipts and the alternate contact number      ->  gone, permanently, with no warning
 *
 * The repository already knew the right shape: the crm_contacts projection in the SAME batch of
 * app/api/canonical-bookings/route.ts, and app/api/admin/data-ingest/route.ts, both COALESCE these
 * two columns onto the stored value. Only the canonical_customers upsert was left unguarded.
 *
 * Nothing here reads a source file. Every test drives a REAL exported route handler against a real
 * SQLite-backed D1 and reads canonical_customers back out afterwards, so the assertion is about what
 * the database holds rather than about what the SQL says.
 *
 * The stored contact is seeded through the production profile authority
 * (lib/customer-account.ts -> mutateCustomerAccount "update_profile"), which is how a customer
 * actually saves these two fields, rather than by a hand-written INSERT.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";

installWorkersHooks("__CONTACT_KEEP_DB__", "__CONTACT_KEEP_ENV__");

/* What the customer saved and must still own after a booking. */
const STORED_EMAIL = "asha.kulkarni@example.in";
const STORED_SECOND_PHONE = "+919800000042";
const NAME = "Asha Kulkarni";
const PRIMARY_PHONE = "+919800000077";

/* The payload shapes every surface is driven with. `silent` is what every booking client actually
 * sends today; the rest exist so the guard is tested from both sides rather than only the safe one. */
const NEW_EMAIL = "asha.new@example.in";
const NEW_SECOND_PHONE = "+919800000099";
const SHAPES = {
  silent: {},
  // The exact damage that was observed in production: email arrived NULL and secondary_phone arrived "".
  blank: { email: "", secondaryPhone: "" },
  // The same absence spelled with whitespace, which a trimmed-but-not-emptied input posts.
  blankPadded: { email: "   ", secondaryPhone: "\t " },
  filled: { email: NEW_EMAIL, secondaryPhone: NEW_SECOND_PHONE },
  // A booking legitimately carrying a corrected name and primary phone. Both MUST land.
  renamed: { name: "Asha Kulkarni-Rao", primaryPhone: "+919800000078" },
  // The three shapes a booking must never be able to write to the identity columns.
  emptyName: { name: "" },
  emptyPrimaryPhone: { primaryPhone: "" },
};

/** A fresh isolate: new sqlite, new D1 binding (route modules memoise their DDL on the binding). */
function freshWorld(env = {}) {
  const harness = freshCountingD1();
  globalThis.__CONTACT_KEEP_DB__ = harness.db;
  globalThis.__CONTACT_KEEP_ENV__ = {
    PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_SCHEDULING_ENV: "uat",
    PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE: "on", PAWSPACE_MAPS_ENV: "sandbox", ...env,
  };
  harness.sqlite.exec("PRAGMA journal_mode=MEMORY;");
  return harness;
}

/**
 * One customer who has saved an email and an alternate phone, and owns one dog.
 * The contact details are written by the REAL profile mutation, not by the fixture.
 */
async function seedCustomerWithContact(db, sqlite, customerId, petId) {
  const account = await import("../lib/customer-account.ts");
  await account.ensureCustomerAccountTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,NULL,NULL,'customer_app','{}',?,?)")
    .run(customerId, "blr", NAME, PRIMARY_PHONE, now, now);
  await account.mutateCustomerAccount(db, {
    customerId, action: "update_profile", idempotencyKey: `profile:${customerId}`,
    profile: { name: NAME, primaryPhone: PRIMARY_PHONE, secondaryPhone: STORED_SECOND_PHONE, email: STORED_EMAIL, cityId: "blr" },
  });
  sqlite.prepare("INSERT INTO canonical_pets(id,customer_id,source_pet_id,name,species,breed,vaccination_status,created_at,updated_at) VALUES (?,?,?,?,'dog','Indie','verified',?,?)")
    .run(petId, customerId, petId, "Bruno", now, now);
  const seeded = contactOf(sqlite, customerId);
  assert.equal(seeded.email, STORED_EMAIL, "fixture: the customer starts with a saved email");
  assert.equal(seeded.secondary_phone, STORED_SECOND_PHONE, "fixture: and a saved alternate phone");
  return { customerId, petId };
}

const contactOf = (sqlite, customerId) =>
  sqlite.prepare("SELECT name,primary_phone,secondary_phone,email,city_id,source,created_at FROM canonical_customers WHERE id=?").get(customerId);

/** POST a real route handler. localhost + PAWSPACE_LOCAL_PREVIEW=on resolves the development-preview
 *  actor, which is what carries these requests past ownership without inventing a session. */
async function post(modulePath, path, body) {
  const route = await import(modulePath);
  const response = await route.POST(new Request(`http://localhost${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  let parsed = null;
  try { parsed = JSON.parse(await response.clone().text()); } catch { /* non-JSON */ }
  return { status: response.status, body: parsed };
}

/** The customer block a booking sends, with one of the shapes above applied. */
const customerBlock = (customerId, shape) => ({ id: customerId, name: NAME, primaryPhone: PRIMARY_PHONE, ...SHAPES[shape] });
/* CONTACT-4 drives each surface once with a blank cityId, to show the column cannot be emptied. */
const cityOf = (blank) => (blank ? "" : "blr");

/* =====================================================================================================
 * The six surfaces. Each `surface` builds its own real fixture world and drives its own real route.
 * ===================================================================================================== */

const SCHEDULING_DDL = [
  "CREATE TABLE IF NOT EXISTS scheduling_assignment_decisions (group_id TEXT PRIMARY KEY,strategy TEXT NOT NULL,shortlist_json TEXT NOT NULL,selected_provider_id TEXT,status TEXT NOT NULL,actor_id TEXT,reason TEXT,updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,lease_expires_at INTEGER,customer_session_id TEXT,attempt_id TEXT)",
  "CREATE TABLE IF NOT EXISTS provider_assignment_offers (group_id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',offered_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,responded_at INTEGER,response_reason TEXT,attempt_no INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL)",
];

function seedScheduling(sqlite, { groupId, providerId, customerId, petIds, serviceCode, cityId, zoneId, scheduledStart, scheduledEnd, careMode = null, shortlist = "[]" }) {
  for (const ddl of SCHEDULING_DDL) sqlite.exec(ddl);
  sqlite.prepare("INSERT OR REPLACE INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,reason,updated_at) VALUES (?,?,?,?,'assigned','fixture','seeded',?)")
    .run(groupId, "governed", shortlist, providerId, Date.now());
  sqlite.prepare("INSERT OR REPLACE INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,1,?,'held','{}',?)")
    .run(`RES-${groupId}`, groupId, providerId, serviceCode, cityId, zoneId, customerId, JSON.stringify(petIds), scheduledStart, scheduledEnd, careMode, Date.now());
}

/** A window comfortably in the future, truncated to a whole second (the quote guards compare instants). */
function futureWindow({ startInHours = 48, durationHours = 1 } = {}) {
  const startMs = Math.floor((Date.now() + startInHours * 3_600_000) / 1000) * 1000;
  return { scheduledStart: new Date(startMs).toISOString(), scheduledEnd: new Date(startMs + durationHours * 3_600_000).toISOString() };
}

let seq = 0;
const tag = () => `${++seq}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

/* --- 1/6  POST /api/canonical-bookings (grooming, boarding, sitting, training, vet) ------------- */
async function canonicalBookingSurface(shape, blankCity = false) {
  const { sqlite, db } = freshWorld();
  const customerId = `CUS-CANON-${tag()}`, petId = `PET-CANON-${tag()}`;
  await seedCustomerWithContact(db, sqlite, customerId, petId);
  const groupId = `GRP-CANON-${tag()}`, providerId = "sit_sana";
  const window = futureWindow({ durationHours: 1 });
  seedScheduling(sqlite, { groupId, providerId, customerId, petIds: [petId], serviceCode: "pet_sitting", cityId: "blr", zoneId: "koramangala", ...window });
  const { createCapturedCanonicalSittingQuote } = await import("./helpers/canonical-sitting-commercial.mjs");
  const { quote } = await createCapturedCanonicalSittingQuote(db, { ...window, cityId: "blr", zoneId: "koramangala", petCount: 1, paymentMode: "prepaid", paymentKey: `contact:${groupId}` });

  const result = await post("../app/api/canonical-bookings/route.ts", "/api/canonical-bookings", {
    idempotencyKey: `contact:canon:${groupId}`, scheduleGroupId: groupId,
    customer: customerBlock(customerId, shape),
    pets: [{ sourceId: petId, name: "Bruno", species: "dog", vaccinationStatus: "verified" }],
    cityId: cityOf(blankCity), zoneId: "koramangala", serviceCode: "pet_sitting",
    packageCode: quote.packageCode, packageName: quote.packageName,
    scheduledStart: window.scheduledStart, scheduledEnd: window.scheduledEnd,
    provider: { id: providerId, name: "Sana S.", model: "full_time" },
    totalAmount: quote.totalAmount, amountDueNow: quote.amountDueNow,
    payment: { method: "upi", mode: quote.paymentMode, status: "captured", detail: "contact preservation" },
    pricing: { discount: 0, sittingQuoteId: quote.quoteId },
  });
  return { result, sqlite, customerId };
}

/* --- 2/6  POST /api/walking-bookings ------------------------------------------------------------ */
async function walkingBookingSurface(shape, blankCity = false) {
  const { sqlite, db } = freshWorld();
  const customerId = `CUS-WALK-${tag()}`, petId = `PET-WALK-${tag()}`;
  await seedCustomerWithContact(db, sqlite, customerId, petId);
  const governance = await import("../lib/walking-governance.ts");
  await governance.ensureWalkingGovernanceTables(db);
  const window = futureWindow({ durationHours: 0.5 });
  const groupId = `GRP-WALK-${tag()}`, providerId = "walker_dev";
  seedScheduling(sqlite, { groupId, providerId, customerId, petIds: [petId], serviceCode: "dog_walking", cityId: "blr", zoneId: "blr-east", careMode: "once", ...window });
  const quote = await governance.createWalkingQuote(db, {
    packageCode: "walking-30", mode: "once", petCount: 1, walkCount: 1, paymentMode: "pay_after_service", ...window,
  });

  const result = await post("../app/api/walking-bookings/route.ts", "/api/walking-bookings", {
    idempotencyKey: `contact:walk:${groupId}`, scheduleGroupId: groupId, walkingQuoteId: quote.quoteId,
    customer: customerBlock(customerId, shape),
    pets: [{ sourceId: petId, name: "Bruno", species: "dog" }],
    cityId: cityOf(blankCity), zoneId: "blr-east",
    packageCode: quote.packageCode, packageName: quote.packageName,
    walkCount: 1, weekdays: [], scheduledStart: quote.scheduledStart, scheduledEnd: quote.scheduledEnd,
    provider: { id: providerId, name: "Dev Walker", model: "full_time" },
    totalAmount: quote.totalAmount, amountDueNow: quote.amountDueNow,
    payment: { method: "upi", mode: "pay_after_service", detail: "contact preservation" },
  });
  return { result, sqlite, customerId };
}

/* --- 3/6  POST /api/sitting-bookings ------------------------------------------------------------ */
const SITTING_ADDRESS = { serviceAddress: "42, Indiranagar Double Road, Stage 2, Bengaluru", servicePincode: "560038", latitude: 12.9784, longitude: 77.6408 };

async function sittingBookingSurface(shape, blankCity = false) {
  const { sqlite, db } = freshWorld();
  const customerId = `CUS-SIT-${tag()}`, petId = `PET-SIT-${tag()}`;
  await seedCustomerWithContact(db, sqlite, customerId, petId);
  const window = futureWindow({ durationHours: 1 });
  const groupId = `GRP-SIT-${tag()}`, providerId = "sit_sana";
  seedScheduling(sqlite, {
    groupId, providerId, customerId, petIds: [petId], serviceCode: "pet_sitting", cityId: "blr", zoneId: "blr-east",
    careMode: "visit", ...window,
    // The Sitting route re-derives the doorstep address from the scheduling decision's own request
    // evidence, which is what /api/uat-scheduling records there.
    shortlist: JSON.stringify({ request: { customerId, serviceCode: "pet_sitting", cityId: "blr", zoneId: "blr-east", ...SITTING_ADDRESS } }),
  });
  const { createCapturedCanonicalSittingQuote } = await import("./helpers/canonical-sitting-commercial.mjs");
  const { quote } = await createCapturedCanonicalSittingQuote(db, { ...window, cityId: "blr", zoneId: "blr-east", petCount: 1, paymentMode: "prepaid", paymentKey: `contact:${groupId}` });

  const result = await post("../app/api/sitting-bookings/route.ts", "/api/sitting-bookings", {
    idempotencyKey: `contact:sit:${groupId}`, scheduleGroupId: groupId, sittingQuoteId: quote.quoteId,
    customer: customerBlock(customerId, shape),
    pets: [{ sourceId: petId, name: "Bruno", species: "dog", vaccinationStatus: "verified" }],
    cityId: cityOf(blankCity), zoneId: "blr-east",
    packageCode: quote.packageCode, packageName: quote.packageName,
    scheduledStart: window.scheduledStart, scheduledEnd: window.scheduledEnd,
    provider: { id: providerId, name: "Sana S.", model: "full_time" },
    totalAmount: quote.totalAmount, amountDueNow: quote.amountDueNow,
    payment: { method: "payment_link", mode: "prepaid", detail: "contact preservation" },
  });
  return { result, sqlite, customerId };
}

/* --- 4/6  POST /api/taxi-bookings (Pet Taxi Gate 1, route-class fares) --------------------------- */
async function taxiBookingSurface(shape, blankCity = false) {
  const { sqlite, db } = freshWorld();
  const customerId = `CUS-TAXI-${tag()}`, petId = `PET-TAXI-${tag()}`;
  await seedCustomerWithContact(db, sqlite, customerId, petId);
  const governance = await import("../lib/taxi-governance.ts");
  const start = futureWindow({ durationHours: 1 }).scheduledStart;
  const quote = await governance.createTaxiQuote(db, {
    routeCode: "taxi-blr-east-short", originLabel: "Indiranagar pickup point",
    destinationLabel: "Whitefield veterinary clinic", petCount: 1,
    scheduledStart: start, paymentMode: "sandbox_deferred",
  });
  const groupId = `GRP-TAXI-${tag()}`, providerId = "taxi_rahul";
  seedScheduling(sqlite, {
    groupId, providerId, customerId, petIds: [petId], serviceCode: "pet_taxi", cityId: "blr", zoneId: "blr-east",
    scheduledStart: quote.scheduledStart, scheduledEnd: quote.scheduledEnd,
  });

  const result = await post("../app/api/taxi-bookings/route.ts", "/api/taxi-bookings", {
    idempotencyKey: `contact:taxi:${groupId}`, scheduleGroupId: groupId, taxiQuoteId: quote.quoteId,
    customer: customerBlock(customerId, shape),
    pets: [{ sourceId: petId, name: "Bruno", species: "dog" }],
    cityId: cityOf(blankCity), zoneId: "blr-east",
    routeCode: quote.routeCode, originLabel: quote.originLabel, destinationLabel: quote.destinationLabel,
    scheduledStart: quote.scheduledStart, scheduledEnd: quote.scheduledEnd,
    provider: { id: providerId, name: "Rahul K.", model: "full_time" },
    totalAmount: quote.totalAmount, amountDueNow: quote.amountDueNow,
    payment: { method: "upi", mode: "sandbox_deferred", detail: "contact preservation" },
  });
  return { result, sqlite, customerId };
}

/* --- 5/6  POST /api/taxi-ride-bookings (Pet Taxi v2, distance fares + reserved vehicle) ---------- */
async function taxiRideBookingSurface(shape, blankCity = false) {
  const { sqlite, db } = freshWorld();
  const customerId = `CUS-RIDE-${tag()}`, petId = `PET-RIDE-${tag()}`;
  await seedCustomerWithContact(db, sqlite, customerId, petId);
  const ride = await import("../lib/taxi-ride-governance.ts");
  const start = futureWindow({ durationHours: 1 }).scheduledStart;
  const quote = await ride.createTaxiRideQuote(db, {
    originLabel: "Indiranagar 100 Feet Road", destinationLabel: "Whitefield veterinary clinic",
    passengerCount: 1, petCount: 1, luggageCount: 0, scheduledStart: start,
    tripType: "one_way", ridePurpose: "regular", waitingMinutes: 0,
    distanceKm: 12, estimatedDurationMinutes: 45, routeProvider: "uat_route_class",
  });
  const option = quote.fareOptions.citroen_ec3;
  const groupId = `GRP-RIDE-${tag()}`, providerId = "taxi_rahul";
  seedScheduling(sqlite, {
    groupId, providerId, customerId, petIds: [petId], serviceCode: "pet_taxi", cityId: "blr", zoneId: "blr-east",
    scheduledStart: quote.scheduledStart, scheduledEnd: quote.scheduledEnd,
  });

  const result = await post("../app/api/taxi-ride-bookings/route.ts", "/api/taxi-ride-bookings", {
    idempotencyKey: `contact:ride:${groupId}`, scheduleGroupId: groupId, taxiQuoteId: quote.quoteId,
    vehicleClass: "citroen_ec3",
    customer: customerBlock(customerId, shape),
    pets: [{ sourceId: petId, name: "Bruno", species: "dog" }],
    cityId: cityOf(blankCity), zoneId: "blr-east",
    scheduledStart: quote.scheduledStart, scheduledEnd: quote.scheduledEnd,
    provider: { id: providerId, name: "Rahul K.", model: "commission" },
    totalAmount: option.quotedTotal, amountDueNow: option.bookingFee,
    channel: "customer_app",
  });
  return { result, sqlite, customerId };
}

/* --- 6/6  POST /api/food-orders (Fresh Food) ----------------------------------------------------- */
async function foodOrderSurface(shape, blankCity = false) {
  const { sqlite, db } = freshWorld();
  const customerId = `CUS-FOOD-${tag()}`, petId = `PET-FOOD-${tag()}`;
  await seedCustomerWithContact(db, sqlite, customerId, petId);
  const food = await import("../lib/food-governance.ts");
  await food.ensureFoodGovernanceTables(db);
  const quote = await food.createFoodQuote(db, {
    sku: "food-uat-dog-adult-2kg", quantity: 1, zoneId: "blr-east",
    paymentMode: "sandbox_deferred", customerId, petIds: [petId],
  });

  const result = await post("../app/api/food-orders/route.ts", "/api/food-orders", {
    idempotencyKey: `contact:food:${tag()}`, quoteId: quote.quoteId,
    customer: customerBlock(customerId, shape),
    cityId: cityOf(blankCity), zoneId: "blr-east",
  });
  return { result, sqlite, customerId };
}

/* Every surface, driven the same way. Named so a failure says WHICH booking erased the contact. */
const SURFACES = [
  ["POST /api/canonical-bookings", canonicalBookingSurface],
  ["POST /api/walking-bookings", walkingBookingSurface],
  ["POST /api/sitting-bookings", sittingBookingSurface],
  ["POST /api/taxi-bookings", taxiBookingSurface],
  ["POST /api/taxi-ride-bookings", taxiRideBookingSurface],
  ["POST /api/food-orders", foodOrderSurface],
];

/** The booking must actually have been written; a refusal would preserve the contact vacuously. */
function assertBooked(surfaceName, result) {
  assert.equal(result.status, 201,
    `${surfaceName}: the fixture must produce a REAL booking, otherwise "the contact survived" proves nothing - got ${result.status} ${JSON.stringify(result.body)}`);
}

// --- CONTACT-1  the defect itself --------------------------------------------------------------

for (const [surfaceName, surface] of SURFACES) {
  test(`CONTACT-1 ${surfaceName}: a booking that sends no email and no alternate phone keeps both`, async () => {
    const { result, sqlite, customerId } = await surface("silent");
    assertBooked(surfaceName, result);
    const after = contactOf(sqlite, customerId);
    assert.equal(after.email, STORED_EMAIL,
      `${surfaceName} erased the customer's saved email; invoices and receipts go to that address and nothing warned them`);
    assert.equal(after.secondary_phone, STORED_SECOND_PHONE,
      `${surfaceName} erased the customer's saved alternate contact number`);
  });

  test(`CONTACT-2 ${surfaceName}: an EMPTY STRING from an untouched form field keeps both`, async () => {
    // A bare COALESCE does not see "" as absent. Both spellings of "the customer typed nothing"
    // are normalised to NULL at the binding site, so both have to be exercised here.
    for (const shape of ["blank", "blankPadded"]) {
      const { result, sqlite, customerId } = await surface(shape);
      assertBooked(`${surfaceName} (${shape})`, result);
      const after = contactOf(sqlite, customerId);
      assert.equal(after.email, STORED_EMAIL, `${surfaceName}: an empty ${shape} email overwrote a stored one`);
      assert.equal(after.secondary_phone, STORED_SECOND_PHONE, `${surfaceName}: an empty ${shape} alternate phone overwrote a stored one`);
    }
  });

  test(`CONTACT-3 ${surfaceName}: a booking that DOES carry new contact details still updates them`, async () => {
    // The fix must not make these columns permanently unwritable from a booking.
    const { result, sqlite, customerId } = await surface("filled");
    assertBooked(surfaceName, result);
    const after = contactOf(sqlite, customerId);
    assert.equal(after.email, NEW_EMAIL, `${surfaceName}: a genuinely supplied email must still land`);
    assert.equal(after.secondary_phone, NEW_SECOND_PHONE, `${surfaceName}: a genuinely supplied alternate phone must still land`);
  });
}

// --- CONTACT-4  the OTHER columns in the same upsert -------------------------------------------
//
// name, primary_phone and city_id are also written with a bare `excluded.` in the same clause, and
// they are deliberately LEFT that way: a booking is an authoritative update for all three. What makes
// that safe is not the clause, it is that no booking can reach the clause carrying a blank one — so
// that is what is asserted here, per surface, rather than assumed.

for (const [surfaceName, surface] of SURFACES) {
  test(`CONTACT-4 ${surfaceName}: a booking cannot reach the upsert with a blank name, phone or city`, async () => {
    for (const shape of ["emptyName", "emptyPrimaryPhone"]) {
      const { result, sqlite, customerId } = await surface(shape);
      assert.equal(result.status, 400, `${surfaceName}: a blank ${shape} must be refused at the boundary, not written - got ${JSON.stringify(result.body)}`);
      const after = contactOf(sqlite, customerId);
      assert.equal(after.name, NAME, `${surfaceName}: the refused booking must leave the stored name alone`);
      assert.equal(after.primary_phone, PRIMARY_PHONE, `${surfaceName}: and the stored primary phone`);
    }
    // city_id: every booking surface refuses a city that does not match its governed reservation, and
    // /api/food-orders substitutes its default instead. Either way the column cannot be blanked.
    const { result, sqlite, customerId } = await surface("silent", true);
    const after = contactOf(sqlite, customerId);
    assert.equal(after.city_id, "blr", `${surfaceName}: a blank cityId reached canonical_customers - got ${JSON.stringify(after)} after ${result.status} ${JSON.stringify(result.body)}`);
  });
}

// --- CONTACT-5  a booking is a legitimate author of the identity columns ------------------------

test("CONTACT-5: a booking that corrects the name and primary phone still updates both", async () => {
  const { result, sqlite, customerId } = await canonicalBookingSurface("renamed");
  assertBooked("POST /api/canonical-bookings", result);
  const after = contactOf(sqlite, customerId);
  assert.equal(after.name, SHAPES.renamed.name, "a booking is an authoritative update for the customer's name");
  assert.equal(after.primary_phone, SHAPES.renamed.primaryPhone, "and for their primary phone");
  // ...and the contact columns it said nothing about are still theirs.
  assert.equal(after.email, STORED_EMAIL);
  assert.equal(after.secondary_phone, STORED_SECOND_PHONE);
});

// --- CONTACT-6  the columns the clause does not name at all ------------------------------------

test("CONTACT-6: a booking does not rewrite source or created_at", async () => {
  const { sqlite, customerId } = await canonicalBookingSurface("silent");
  const after = contactOf(sqlite, customerId);
  assert.equal(after.source, "customer_app",
    "source is absent from the conflict clause on purpose: a booking must not relabel where the customer came from");
  assert.ok(Number(after.created_at) > 0 && Number(after.created_at) <= Date.now(),
    "created_at is absent from the clause too - a booking must not reset when the customer joined");
});

// --- CONTACT-7  the ratchet --------------------------------------------------------------------

test("CONTACT-7: no surface writes canonical_customers with the destructive clause", async () => {
  const fs = await import("node:fs");
  const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const files = fs.readdirSync(new URL("../app/api", import.meta.url), { recursive: true })
    .filter((f) => String(f).endsWith("route.ts"))
    .map((f) => `app/api/${String(f).replaceAll("\\", "/")}`)
    .concat(fs.readdirSync(new URL("../lib", import.meta.url)).filter((f) => f.endsWith(".ts")).map((f) => `lib/${f}`));

  // Whitespace-tolerant: `email = excluded . email` is the same destructive write.
  const offenders = files.filter((file) => ["secondary_phone", "email"].some((column) =>
    new RegExp(`INSERT INTO canonical_customers[\\s\\S]*?${column}\\s*=\\s*excluded\\s*\\.\\s*${column}`, "i").test(read(file))));

  assert.deepEqual(offenders, [],
    `these overwrite a stored customer contact with whatever the caller happened to send; COALESCE onto ` +
    `canonical_customers.<column> as every other surface does:\n  ${offenders.join("\n  ")}`);
});
