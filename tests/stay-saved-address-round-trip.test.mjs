/**
 * Executable regression for the saved-address corruption loop behind /sitting and /boarding.
 *
 * The loop, as measured in UAT (line1 grew 178 -> 210 -> 242 -> 274 chars over three PREVIEWS, one extra
 * customer_addresses row each time, each new row promoted to is_default=1):
 *
 *   savedStayAddressText()            composes  [line1,line2,area,city,postalCode].join(", ")
 *   stay-flow preview/confirm         sends that ONE composed string as serviceAddress
 *   resolveGovernedServiceAddress()   stored the whole composed string back into line1, as a NEW default row
 *   defaultStayAddress()              next visit reads that row and composes it again  -> + ", area, city, PIN"
 *
 * These tests drive the real functions - the same composer the screen uses, the real customer-account
 * reader, and the real address authority against a real SQLite database - so they fail if either half of
 * the defect comes back: the composed string being stored as a structured field, or a read-only preview
 * writing a customer address at all.
 *
 * Geocoding is deliberately left unconfigured (no maps key, no test fixture), so the authority takes its
 * governed GPS-fallback branch instead of reaching the network. The address round trip under test is
 * unaffected by which branch produced the coordinates.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";

installWorkersHooks("__STAY_ADDRESS_ROUND_TRIP_DB__");
globalThis.__STAY_ADDRESS_ROUND_TRIP_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_MAPS_ENV: "sandbox" };

const { ensureCustomerAccountTables, readCustomerAccount } = await import("../lib/customer-account.ts");
const { defaultStayAddress, savedStayAddressText } = await import("../lib/stay-saved-address.ts");
const { resolveGovernedServiceAddress } = await import("../lib/service-discovery-address.ts");
const { savedAddressDisplayText } = await import("../app/mobile-app/customer-account-view.tsx");

const CUSTOMER = "CUST-STAY-ROUNDTRIP";
const HOME_LINE1 = "42, Indiranagar Double Road, Stage 2, Hoysala Nagar";
const CUSTOMER_GPS = { latitude: 12.9716, longitude: 77.5946 };
/* The spelling the app's OWN address picker produces. lib/address-autocomplete.ts ships exactly this string
 * as its Places fixture, and every Places-shaped fixture in this repo agrees: city and PIN arrive as ONE
 * comma segment ("Bengaluru 560038"), not as two. HOME_LINE1 above carries no city or PIN inside line1,
 * which is precisely why the round-1 suite never exercised the combined segment. */
const PICKER_FULL_TEXT = `${HOME_LINE1}, Indiranagar, Bengaluru 560038`;

async function world() {
  const { sqlite, db } = freshCountingD1();
  await ensureCustomerAccountTables(db);
  const now = Date.now();
  await db.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,'blr','Round Trip','9000000451',NULL,NULL,'customer_app','{}',?,?)")
    .bind(CUSTOMER, now, now).run();
  await db.prepare("INSERT INTO customer_addresses (id,customer_id,label,line1,line2,area,city,postal_code,is_default,created_at,updated_at) VALUES ('ADDR-HOME',?,'Home',?,NULL,'Indiranagar','Bengaluru','560038',1,?,?)")
    .bind(CUSTOMER, HOME_LINE1, now, now).run();
  return { sqlite, db };
}

/** One /sitting visit, exactly as the screen does it: read the account, pick the default address,
 *  compose it with the shipped composer, and hand that one string to the address authority. */
async function visit(db, { action, serviceAddress, servicePincode } = {}) {
  const account = await readCustomerAccount(db, CUSTOMER);
  const saved = defaultStayAddress(account.addresses);
  const sent = serviceAddress ?? savedStayAddressText(saved);
  const pincode = servicePincode ?? saved?.postalCode ?? "";
  const governed = await resolveGovernedServiceAddress(db, {
    customerId: CUSTOMER, serviceCode: "pet_sitting", serviceAddress: sent, servicePincode: pincode,
    ...CUSTOMER_GPS, persist: action !== "preview",
  });
  return { sent, governed, savedLine1: saved?.line1 ?? null };
}

function addressRows(sqlite) {
  return sqlite.prepare("SELECT id,line1,area,city,postal_code,is_default FROM customer_addresses WHERE customer_id=? ORDER BY is_default DESC,id").all(CUSTOMER);
}

test("previewing a saved stay address three times never grows it and never adds a row", async () => {
  const { sqlite, db } = await world();
  const composed = [];
  const navigation = [];
  for (let round = 0; round < 4; round++) {
    const { sent, governed } = await visit(db, { action: "preview" });
    composed.push(sent);
    navigation.push(governed.address);
  }
  for (const [index, text] of composed.entries()) {
    assert.equal(text.length, composed[0].length, `visit ${index + 1} composed ${text.length} chars, visit 1 composed ${composed[0].length}: ${text}`);
    assert.equal(text, composed[0], `visit ${index + 1} composed a different address: ${text}`);
  }
  // The address handed to navigation must be stable too - drivers receive this string.
  for (const url of navigation) assert.equal(url, navigation[0], `navigation address drifted: ${url}`);
  assert.equal(navigation[0].match(/560038/g).length, 1, `the PIN is repeated in the navigation address: ${navigation[0]}`);

  const rows = addressRows(sqlite);
  assert.equal(rows.length, 1, `previews appended address rows: ${JSON.stringify(rows)}`);
  assert.equal(rows[0].id, "ADDR-HOME", "the customer's own address row is still the one in use");
  assert.equal(rows[0].line1, HOME_LINE1, `line1 was overwritten with a composed display string: ${rows[0].line1}`);
  assert.equal(Number(rows[0].is_default), 1);
  assert.equal(rows[0].area, "Indiranagar");
  assert.equal(rows[0].city, "Bengaluru");
});

test("booking the same saved address three times is equally stable", async () => {
  const { sqlite, db } = await world();
  const composed = [];
  for (let round = 0; round < 3; round++) composed.push((await visit(db, { action: "reserve" })).sent);
  assert.equal(new Set(composed).size, 1, `repeat bookings re-composed the saved address: ${JSON.stringify(composed)}`);
  const rows = addressRows(sqlite);
  assert.equal(rows.length, 1, `repeat bookings appended address rows: ${JSON.stringify(rows)}`);
  assert.equal(rows[0].line1, HOME_LINE1);
  assert.equal(Number(rows[0].is_default), 1);
});

test("a genuinely new address is still saved, promoted to default, and is itself stable afterwards", async () => {
  const { sqlite, db } = await world();
  const typed = "9, 80 Feet Road, Koramangala 4th Block";
  const { governed } = await visit(db, { action: "reserve", serviceAddress: typed, servicePincode: "560034" });
  assert.equal(governed.pincode, "560034");
  assert.equal(governed.zoneId, "blr-south", "city, zone and coordinates stay server-governed");

  const rows = addressRows(sqlite);
  assert.equal(rows.length, 2, `the new address must be saved and the old one kept: ${JSON.stringify(rows)}`);
  const current = rows.find((row) => Number(row.is_default) === 1);
  assert.equal(rows.filter((row) => Number(row.is_default) === 1).length, 1, "exactly one default");
  assert.equal(current.line1, typed, "the new address is stored as the customer typed it");
  assert.equal(current.postal_code, "560034");
  assert.equal(current.area, "Koramangala", "area and city are filled in from the governed zone, not from the client");
  assert.equal(current.city, "Bengaluru");

  // The address just saved now becomes the composed default - it must not grow either.
  const composed = [];
  for (let round = 0; round < 3; round++) composed.push((await visit(db, { action: "preview" })).sent);
  assert.equal(new Set(composed).size, 1, `the newly saved address grew on re-visit: ${JSON.stringify(composed)}`);
  assert.equal(composed[0], `${typed}, Koramangala, Bengaluru, 560034`);
  assert.equal(addressRows(sqlite).length, 2, "and re-visiting it adds no further rows");
});

test("a new address in the same PIN is still recognised as new, not merged into the saved one", async () => {
  const { sqlite, db } = await world();
  const typed = "7, Chinmaya Mission Hospital Road, Stage 1";
  await visit(db, { action: "reserve", serviceAddress: typed, servicePincode: "560038" });
  const rows = addressRows(sqlite);
  assert.equal(rows.length, 2, `a different street in the same PIN is a different address: ${JSON.stringify(rows)}`);
  assert.equal(rows.find((row) => Number(row.is_default) === 1).line1, typed);
  assert.equal(rows.find((row) => Number(row.is_default) === 0).line1, HOME_LINE1, "the previous address is kept intact");
});

test("a saved address that never carried a PIN resolves against the request PIN instead of duplicating", async () => {
  const { sqlite, db } = await world();
  sqlite.prepare("UPDATE customer_addresses SET postal_code=NULL WHERE id='ADDR-HOME'").run();
  const composed = [];
  for (let round = 0; round < 3; round++) {
    // The screen infers the PIN from the address text when the saved row has none.
    const account = await readCustomerAccount(db, CUSTOMER);
    const saved = defaultStayAddress(account.addresses);
    const sent = savedStayAddressText(saved);
    composed.push(sent);
    const governed = await resolveGovernedServiceAddress(db, {
      customerId: CUSTOMER, serviceCode: "pet_sitting", serviceAddress: sent, servicePincode: "560038",
      ...CUSTOMER_GPS, persist: true,
    });
    assert.equal(governed.pincode, "560038");
    assert.equal(governed.addressId, "ADDR-HOME", "the customer's own row stays the governed address");
  }
  assert.equal(new Set(composed).size, 1, `the PIN-less saved address grew: ${JSON.stringify(composed)}`);
  assert.deepEqual(addressRows(sqlite).map((row) => row.id), ["ADDR-HOME"], "and it was not duplicated");
});

/* The tests above call the authority directly, so they pin its contract without depending on files other
 * changes are touching. This one pins the caller: scheduling must resolve a preview read-only. */
test("the scheduling route resolves a preview without write authority", () => {
  const route = fs.readFileSync("app/api/uat-scheduling/route.ts", "utf8");
  assert.match(route, /resolveGovernedServiceAddress\(db,\{[^}]*persist:input\.action!=="preview"\}\)/,
    "the preview branch must pass persist:false to the address authority");
});

test("a preview of a typed address saves nothing until the customer actually books it", async () => {
  const { sqlite, db } = await world();
  const typed = "9, 80 Feet Road, Koramangala 4th Block";
  await visit(db, { action: "preview", serviceAddress: typed, servicePincode: "560034" });
  assert.deepEqual(addressRows(sqlite).map((row) => row.id), ["ADDR-HOME"], "a read-only preview must not save a customer address");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM customer_service_address_geocodes").get().n, 0,
    "and it must not leave a geocode row for an address it is not allowed to save");

  await visit(db, { action: "reserve", serviceAddress: typed, servicePincode: "560034" });
  const rows = addressRows(sqlite);
  assert.equal(rows.length, 2, "confirming the booking does save it");
  assert.equal(rows.find((row) => Number(row.is_default) === 1).line1, typed);
});


/* ------------------------------------------------------------------------------------------------ *
 * The gap round 1 left open: the dedupe compared trailing segments by EXACT match, so it recognised the
 * composer's own ", Indiranagar, Bengaluru, 560038" but NOT the picker's ", Indiranagar, Bengaluru 560038".
 * The final segment keyed as "bengaluru560038", stripping stopped there, the core never matched the stored
 * row, and confirming a booking wrote a SECOND address row - carrying the whole composed string as line1 -
 * and promoted it to is_default, silently demoting the address the customer had chosen.
 * ------------------------------------------------------------------------------------------------ */

test("the shipped autocomplete fixture is still the City-PIN-in-one-segment shape these tests assume", () => {
  const autocomplete = fs.readFileSync("lib/address-autocomplete.ts", "utf8");
  assert.match(autocomplete, /fullText:"42, Indiranagar Double Road, Stage 2, Hoysala Nagar, Indiranagar, Bengaluru 560038"/,
    "the picker fixture no longer produces the spelling this regression is written against");
  assert.equal(PICKER_FULL_TEXT, "42, Indiranagar Double Road, Stage 2, Hoysala Nagar, Indiranagar, Bengaluru 560038");
  assert.equal(PICKER_FULL_TEXT.split(",").pop().trim(), "Bengaluru 560038", "city and PIN share one segment");
});

test("the picker's own spelling of the saved address resolves to it: no new row, no stolen default", async () => {
  const { sqlite, db } = await world();
  const before = addressRows(sqlite);

  const { governed } = await visit(db, { action: "reserve", serviceAddress: PICKER_FULL_TEXT, servicePincode: "560038" });
  assert.equal(governed.addressId, "ADDR-HOME", `the picker spelling was treated as a brand new address: ${governed.addressId}`);
  assert.equal(governed.pincode, "560038");

  const rows = addressRows(sqlite);
  assert.equal(rows.length, 1, `confirming a booking duplicated the customer's saved address: ${JSON.stringify(rows)}`);
  assert.deepEqual(rows, before, `the saved row was rewritten by a booking that only recognised it: ${JSON.stringify(rows)}`);
  assert.equal(rows[0].line1, HOME_LINE1, "line1 is untouched - the composed display string is never stored");
  assert.equal(Number(rows[0].is_default), 1, "the customer's own default is still their default");
});

test("every realistic spelling of the saved address resolves to the same row, and none of them writes", async () => {
  const { sqlite, db } = await world();
  const before = addressRows(sqlite);
  const spellings = [
    PICKER_FULL_TEXT,                                                      // Places: "City PIN"
    `${HOME_LINE1}, Indiranagar, Bengaluru, 560038`,                       // savedStayAddressText(): every part its own segment
    `${HOME_LINE1}, Indiranagar, Bengaluru - 560038`,                      // "City - PIN"
    `${HOME_LINE1}, Indiranagar, Bengaluru 560038, India`,                 // geocoder-style country suffix
    `${HOME_LINE1}, Indiranagar Bengaluru 560038`,                         // area, city and PIN all in one segment
    `${HOME_LINE1}, 560038 Bengaluru`,                                     // reversed inside one segment
  ];
  for (const spelling of spellings) {
    const { governed } = await visit(db, { action: "reserve", serviceAddress: spelling, servicePincode: "560038" });
    assert.equal(governed.addressId, "ADDR-HOME", `"${spelling}" was not recognised as the saved address`);
  }
  const rows = addressRows(sqlite);
  assert.equal(rows.length, 1, `one saved address collected a row per spelling: ${JSON.stringify(rows)}`);
  assert.deepEqual(rows, before, `a recognised address was written back: ${JSON.stringify(rows)}`);
});

test("booking a saved address that is NOT the default does not make it the default", async () => {
  const { sqlite, db } = await world();
  const now = Date.now();
  sqlite.prepare("INSERT INTO customer_addresses (id,customer_id,label,line1,line2,area,city,postal_code,is_default,created_at,updated_at) VALUES ('ADDR-WORK',?,'Work','9 Audit Crescent',NULL,'Indiranagar','Bengaluru','560038',0,?,?)")
    .run(CUSTOMER, now, now);

  // The customer picks their non-default Work address in the picker, which spells it "..., Bengaluru 560038".
  const { governed } = await visit(db, { action: "reserve", serviceAddress: "9 Audit Crescent, Indiranagar, Bengaluru 560038", servicePincode: "560038" });
  assert.equal(governed.addressId, "ADDR-WORK", "the non-default saved address is the one that was resolved");

  const rows = addressRows(sqlite);
  assert.equal(rows.length, 2, `booking a saved address added a row: ${JSON.stringify(rows)}`);
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.equal(Number(byId["ADDR-HOME"].is_default), 1, "a booking must not move the customer's chosen default");
  assert.equal(Number(byId["ADDR-WORK"].is_default), 0, "and must not promote the address it merely recognised");
  assert.equal(byId["ADDR-WORK"].line1, "9 Audit Crescent", "nor rewrite its line1 with the composed string");
});

test("a different street in the same PIN, spelled the picker's way, is still a NEW address", async () => {
  const { sqlite, db } = await world();
  const core = "7, Chinmaya Mission Hospital Road, Stage 1";
  await visit(db, { action: "reserve", serviceAddress: `${core}, Indiranagar, Bengaluru 560038`, servicePincode: "560038" });
  const rows = addressRows(sqlite);
  assert.equal(rows.length, 2, `tolerating "City PIN" must not merge two different streets: ${JSON.stringify(rows)}`);
  const current = rows.find((row) => Number(row.is_default) === 1);
  assert.equal(current.line1, core, "and the new row is stored as its core, without the governed tail");
  assert.equal(rows.find((row) => Number(row.is_default) === 0).line1, HOME_LINE1, "the previous address is kept intact");
});

test("a different house number on the same street is still a NEW address", async () => {
  const { sqlite, db } = await world();
  const neighbour = "43, Indiranagar Double Road, Stage 2, Hoysala Nagar";
  await visit(db, { action: "reserve", serviceAddress: `${neighbour}, Indiranagar, Bengaluru 560038`, servicePincode: "560038" });
  const rows = addressRows(sqlite);
  assert.equal(rows.length, 2, `42 and 43 on one street are different addresses: ${JSON.stringify(rows)}`);
  assert.equal(rows.find((row) => Number(row.is_default) === 1).line1, neighbour);
});

test("a segment that merely CONTAINS a governed name is not stripped off the address core", async () => {
  const { sqlite, db } = await world();
  // "Koramangala 4th Block" holds the governed area plus a real part of the address; dropping it would
  // collapse every 80 Feet Road address in 560034 into one row.
  await visit(db, { action: "reserve", serviceAddress: "9, 80 Feet Road, Koramangala 4th Block", servicePincode: "560034" });
  await visit(db, { action: "reserve", serviceAddress: "9, 80 Feet Road, Koramangala 6th Block", servicePincode: "560034" });
  const rows = addressRows(sqlite);
  assert.equal(rows.length, 3, `two different blocks were merged into one address: ${JSON.stringify(rows)}`);
  assert.deepEqual(rows.map((row) => row.line1).sort(),
    ["42, Indiranagar Double Road, Stage 2, Hoysala Nagar", "9, 80 Feet Road, Koramangala 4th Block", "9, 80 Feet Road, Koramangala 6th Block"],
    "each block keeps its own line1, with the governed area still part of it");
});

test("a preview of the picker's spelling of the saved address still writes nothing", async () => {
  const { sqlite, db } = await world();
  const before = addressRows(sqlite);
  for (let round = 0; round < 3; round++) {
    const { governed } = await visit(db, { action: "preview", serviceAddress: PICKER_FULL_TEXT, servicePincode: "560038" });
    assert.equal(governed.addressId, "ADDR-HOME");
  }
  assert.deepEqual(addressRows(sqlite), before, `a read-only preview changed a customer address: ${JSON.stringify(addressRows(sqlite))}`);
});

/* DEFECT 2: the account screen composed [line1, area, city, postalCode] even when line1 already ended with
 * them, so a row saved from the picker rendered its area, city and PIN twice. Display only - the stored
 * line1 is not touched by this, which is what the round trips above keep proving. */
test("saved-address display never repeats the area, city or PIN that line1 already carries", () => {
  const governedTail = { line1: "9 Audit Crescent, Indiranagar, Bengaluru 560038", area: "Indiranagar", city: "Bengaluru", postalCode: "560038" };
  assert.equal(savedAddressDisplayText(governedTail), "9 Audit Crescent, Indiranagar, Bengaluru, 560038");
  assert.equal(savedAddressDisplayText(governedTail).match(/560038/g).length, 1, "the PIN is rendered once");
  assert.equal(savedAddressDisplayText(governedTail).match(/Bengaluru/g).length, 1, "the city is rendered once");
  assert.equal(savedAddressDisplayText(governedTail).match(/Indiranagar/g).length, 1, "the area is rendered once");

  // A clean row is unchanged: the fields the customer did not type into line1 are still shown.
  assert.equal(savedAddressDisplayText({ line1: HOME_LINE1, area: "Indiranagar", city: "Bengaluru", postalCode: "560038" }),
    `${HOME_LINE1}, Indiranagar, Bengaluru, 560038`);
  // A governed name inside a street name is not a repeat and must survive.
  assert.equal(savedAddressDisplayText({ line1: "9, 80 Feet Road, Koramangala 4th Block", area: "Koramangala", city: "Bengaluru", postalCode: "560034" }),
    "9, 80 Feet Road, Koramangala 4th Block, Koramangala, Bengaluru, 560034");
  assert.equal(savedAddressDisplayText({ line1: "12 Church Street", area: null, city: "Bengaluru", postalCode: null }), "12 Church Street, Bengaluru");
});

test("what the account screen displays is what the picker sends back, and it resolves to the same row", async () => {
  const { sqlite, db } = await world();
  const account = await readCustomerAccount(db, CUSTOMER);
  const saved = defaultStayAddress(account.addresses);
  // Display text and the string the stay flow sends agree for a clean row, and both round-trip.
  assert.equal(savedAddressDisplayText(saved), savedStayAddressText(saved));
  const governed = await resolveGovernedServiceAddress(db, {
    customerId: CUSTOMER, serviceCode: "pet_sitting", serviceAddress: savedAddressDisplayText(saved), servicePincode: "560038",
    ...CUSTOMER_GPS, persist: true,
  });
  assert.equal(governed.addressId, "ADDR-HOME");
  assert.deepEqual(addressRows(sqlite).map((row) => row.id), ["ADDR-HOME"]);
});
