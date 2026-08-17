import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ---------------------------------------------------------------------------
// A booking used to mint its own canonical_pets row keyed by the pet NAME, so a pet the customer had
// already saved got a SECOND, empty row and pet_ids_json pointed at that one. Every reader that
// resolves pets through pet_ids_json — the Booking Command Center's Pet & Care card, this route's own
// GET, the partner job feed — then showed an empty profile for a filled-in pet.
//
// The fix resolves pets in phases and derives any NEW id from a digest of the normalized customer and
// source identity. That makes the SOURCE ID the thing identity hangs on, which is why its type matters:
// everything downstream reaches it through String(...), so a non-string hashes as one identity while
// the column's TEXT affinity persists another (7 hashes as "7", stores as "7.0"). The next booking's
// identity lookup then misses its own row, mints again, and the global occupancy check pushes it to
// the next deterministic variant — until the attempt budget is spent and every later booking for that
// pet fails permanently. One malformed request became persistent canonical-pet duplication.
//
// These run the REAL exported POST handler against a real SQLite database. No assertion here matches
// source text: every claim is a row read back out of the database after the production path wrote it,
// or a status code the handler actually returned.
// ---------------------------------------------------------------------------
installWorkersHooks("__PET_IDENTITY_DB__", "__PET_IDENTITY_ENV__");

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

const SCHEDULING_DDL = [
  "CREATE TABLE IF NOT EXISTS scheduling_assignment_decisions (group_id TEXT PRIMARY KEY,strategy TEXT NOT NULL,shortlist_json TEXT NOT NULL,selected_provider_id TEXT,status TEXT NOT NULL,actor_id TEXT,reason TEXT,updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)",
];

const CUSTOMER = "CUS-PETID-1", PROVIDER = "PRV-PETID-1";
const START = "2026-11-04T09:00:00.000Z", END = "2026-11-04T11:00:00.000Z";

/** A fresh isolate: new sqlite, new D1 binding (the libs memoise DDL on the binding object). */
function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__PET_IDENTITY_DB__ = makeD1(sqlite);
  globalThis.__PET_IDENTITY_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox" };
  return sqlite;
}

/** Seed the scheduling decision the booking POST requires before it will confirm anything. */
function seedScheduling(sqlite, groupId) {
  for (const ddl of SCHEDULING_DDL) sqlite.exec(ddl);
  sqlite.prepare("INSERT OR REPLACE INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,reason,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(groupId, "balanced", "[]", PROVIDER, "assigned", "test", "seeded", 1);
  sqlite.prepare("INSERT OR REPLACE INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(`RES-${groupId}`, groupId, PROVIDER, "pet_sitting", "blr", "koramangala", CUSTOMER, "[]", START, END, 1, 1, null, "reserved", "{}", 1);
}

/** The body is built as a STRING, because some of the shapes under test are the point of the test. */
function bookingBody({ key, group, pets }) {
  return JSON.stringify({
    idempotencyKey: key, scheduleGroupId: group,
    customer: { id: CUSTOMER, name: "Identity tester", primaryPhone: "+919000000001" },
    pets,
    cityId: "blr", zoneId: "koramangala",
    serviceCode: "pet_sitting", packageCode: "home-visit", packageName: "Pet Sitting",
    scheduledStart: START, scheduledEnd: END,
    provider: { id: PROVIDER, name: "Sitter One", model: "full_time" },
    totalAmount: 1349, amountDueNow: 1349,
    payment: { method: "upi", mode: "prepaid", status: "captured", detail: "customer app" },
    pricing: { discount: 0 },
  });
}

async function book(sqlite, { key, group, pets, schedule = true }) {
  if (schedule) seedScheduling(sqlite, group);
  const { POST } = await import("../app/api/canonical-bookings/route.ts");
  const response = await POST(new Request("http://localhost/api/canonical-bookings", {
    method: "POST", headers: { "content-type": "application/json" }, body: bookingBody({ key, group, pets }),
  }));
  let body = null;
  try { body = JSON.parse(await response.clone().text()); } catch { /* non-JSON body */ }
  return { status: response.status, body };
}

/** Every table the booking write batch touches. A rejected request must move none of them. */
const TOUCHED_TABLES = ["canonical_pets", "canonical_bookings", "booking_payments", "provider_work_orders", "booking_lifecycle_events"];
const counts = (sqlite) => Object.fromEntries(TOUCHED_TABLES.map((table) => {
  try { return [table, sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n]; } catch { return [table, 0]; }
}));
const ZERO = Object.fromEntries(TOUCHED_TABLES.map((table) => [table, 0]));
const petsOf = (sqlite) => sqlite.prepare("SELECT id,name,breed,vaccination_status,source_pet_id FROM canonical_pets WHERE customer_id=? ORDER BY id").all(CUSTOMER);
const petIdsOf = (sqlite, key) => {
  const row = sqlite.prepare("SELECT pet_ids_json FROM canonical_bookings WHERE idempotency_key=?").get(key);
  return row ? JSON.parse(row.pet_ids_json) : null;
};

/** Create the tables without writing a booking, so a rejected FIRST request has a baseline to compare. */
async function warmSchema(sqlite) {
  await book(sqlite, { key: "warm-schema", group: "SG-WARM", pets: [{ sourceId: "warm", name: "Warm" }] });
  for (const table of TOUCHED_TABLES) sqlite.exec(`DELETE FROM ${table}`);
}

// --- the identity a source id must have ------------------------------------------------------

test("a numeric source id is refused, and refused again, without ever creating a pet", async () => {
  const sqlite = freshDb();
  await warmSchema(sqlite);
  const before = counts(sqlite);

  // Ten in a row: the defect this guards against only showed itself ACROSS bookings. The first
  // request minted a row under one text and every later one missed it and minted another, so a
  // single-shot assertion would have passed while the rows piled up.
  const statuses = [];
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = await book(sqlite, { key: `num-${attempt}`, group: `SG-NUM-${attempt}`, pets: [{ sourceId: 7, name: "Seven" }] });
    statuses.push(result.status);
    assert.equal(result.body?.error, "A pet source id must be text");
  }

  assert.deepEqual(statuses, Array(10).fill(400), "every attempt must be refused, not just the first");
  assert.deepEqual(counts(sqlite), before, "a refused booking must write nothing");
  assert.deepEqual(counts(sqlite), ZERO);
  assert.deepEqual(petsOf(sqlite), [], "no canonical pet may be fabricated by a refused request");
});

test("boolean, array and object source ids are refused with no writes", async () => {
  const sqlite = freshDb();
  await warmSchema(sqlite);

  // JSON can carry all of these where a string belongs. Each is checked three times, because one
  // pass cannot distinguish "refused" from "accepted once, then deduplicated".
  const shapes = [
    ["boolean true", true], ["boolean false", false],
    ["array", [7]], ["array of strings", ["a", "b"]], ["nested array", [[1]]],
    ["object", { id: "x" }], ["nested object", { a: { b: 1 } }],
    ["float", 7.5], ["zero", 0], ["negative", -1], ["large", 1e21],
  ];
  for (const [label, sourceId] of shapes) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await book(sqlite, { key: `shape-${label}-${attempt}`, group: `SG-${label}-${attempt}`, pets: [{ sourceId, name: "P" }] });
      assert.equal(result.status, 400, `${label} must be refused`);
      assert.equal(result.body?.error, "A pet source id must be text", label);
    }
  }
  assert.deepEqual(counts(sqlite), ZERO, "no malformed shape may write anything");
});

test("a source id that is text is unaffected: \"7\" converges on ONE canonical pet", async () => {
  const sqlite = freshDb();

  const statuses = [], bound = new Set();
  for (let attempt = 0; attempt < 10; attempt++) {
    const key = `str-${attempt}`;
    const result = await book(sqlite, { key, group: `SG-STR-${attempt}`, pets: [{ sourceId: "7", name: "Seven" }] });
    statuses.push(result.status);
    bound.add(petIdsOf(sqlite, key)?.[0]);
  }

  assert.deepEqual(statuses, Array(10).fill(201), "the string form must remain a valid booking");
  assert.equal(bound.size, 1, "every booking must bind the same canonical pet");
  const rows = petsOf(sqlite);
  assert.equal(rows.length, 1, "ten bookings for one pet must leave exactly one row");
  assert.equal(rows[0].source_pet_id, "7");
  assert.equal(rows[0].id, [...bound][0]);
});

// --- the rules run in an order history depends on -------------------------------------------

test("a booking created before these rules existed still replays, malformed source id and all", async () => {
  const sqlite = freshDb();
  await warmSchema(sqlite);

  // A booking already in the database, whose original request carried a numeric source id. The rules
  // are checked AFTER the idempotency lookup precisely so that history stays replayable: a payload
  // that would be refused today must still return the booking it originally created.
  sqlite.prepare(`INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at)
    VALUES ('BK-HIST','hist-num',?,'["PET-HIST"]','[7]','blr','koramangala','pet_sitting','home-visit','Pet Sitting','SG-HIST',?,?,?,'confirmed','customer_app',1349,'INR','{}',?,1,1)`)
    .run(CUSTOMER, PROVIDER, START, END, CUSTOMER);
  sqlite.prepare("INSERT INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,source_pet_id,created_at,updated_at) VALUES ('PET-HIST',?,'Seven','dog','Beagle','verified','7.0',1,1)").run(CUSTOMER);
  const before = counts(sqlite);

  const replayByKey = await book(sqlite, { key: "hist-num", group: "SG-OTHER", pets: [{ sourceId: 7, name: "Seven" }] });
  assert.equal(replayByKey.status, 200, "the replay must not be turned into a 400 by the new rule");
  assert.equal(replayByKey.body?.data?.bookingId, "BK-HIST");
  assert.equal(replayByKey.body?.data?.duplicatePrevented, true);

  const replayByGroup = await book(sqlite, { key: "hist-other", group: "SG-HIST", pets: [{ sourceId: { bad: true }, name: "Seven" }] });
  assert.equal(replayByGroup.status, 200, "the schedule-group half of the lookup must behave the same");
  assert.equal(replayByGroup.body?.data?.bookingId, "BK-HIST");

  assert.deepEqual(counts(sqlite), before, "a replay must have no side effects");

  // The control: the same shape on a genuinely NEW booking is still refused. Without this, the two
  // assertions above would also pass if the rule had simply been removed.
  const fresh = await book(sqlite, { key: "hist-fresh", group: "SG-FRESH", pets: [{ sourceId: 7, name: "Seven" }] });
  assert.equal(fresh.status, 400);
  assert.equal(fresh.body?.error, "A pet source id must be text");
  assert.deepEqual(counts(sqlite), before);
});

test("blank, type, control-character and duplicate rules answer in a fixed order", async () => {
  const sqlite = freshDb();
  await warmSchema(sqlite);

  const NUL = String.fromCharCode(0);
  const cases = [
    // Blank is checked first, so null/[]/missing keep the answer they have always had. Any reordering
    // that let the type rule speak first would change what an existing client is told.
    ["null source id", [{ sourceId: null, name: "G" }], "Every pet needs a source id"],
    ["missing source id", [{ name: "G" }], "Every pet needs a source id"],
    ["empty array", [{ sourceId: [], name: "G" }], "Every pet needs a source id"],
    ["empty string", [{ sourceId: "", name: "G" }], "Every pet needs a source id"],
    ["whitespace only", [{ sourceId: "   ", name: "G" }], "Every pet needs a source id"],
    ["blank beats type", [{ sourceId: null, name: "A" }, { sourceId: 7, name: "B" }], "Every pet needs a source id"],
    // Then the type, before anything that reads the value as text.
    ["type beats control character", [{ sourceId: 7, name: "A" }, { sourceId: `a${NUL}b`, name: "B" }], "A pet source id must be text"],
    ["type beats duplicate", [{ sourceId: 7, name: "A" }, { sourceId: 7, name: "B" }], "A pet source id must be text"],
    // Then control characters: a source id is hashed with a NUL separator, so one embedded in the
    // value could shape one identity's digest material into another's.
    ["embedded NUL", [{ sourceId: `a${NUL}b`, name: "A" }], "A pet source id cannot contain control characters"],
    ["tab", [{ sourceId: `a${String.fromCharCode(9)}b`, name: "A" }], "A pet source id cannot contain control characters"],
    ["control beats duplicate", [{ sourceId: `a${NUL}b`, name: "A" }, { sourceId: `a${NUL}b`, name: "B" }], "A pet source id cannot contain control characters"],
    // Then distinctness, normalized the same way the resolver normalizes.
    ["exact duplicate", [{ sourceId: "dup", name: "A" }, { sourceId: "dup", name: "B" }], "Each pet in this booking needs its own source id"],
    ["case-only duplicate", [{ sourceId: "Dup", name: "A" }, { sourceId: "dUP", name: "B" }], "Each pet in this booking needs its own source id"],
    ["whitespace-only duplicate", [{ sourceId: " dup ", name: "A" }, { sourceId: "dup", name: "B" }], "Each pet in this booking needs its own source id"],
  ];

  for (const [label, pets, expected] of cases) {
    const key = `order-${label.replace(/\s+/g, "-")}`;
    const result = await book(sqlite, { key, group: `SG-${key}`, pets });
    assert.equal(result.status, 400, label);
    assert.equal(result.body?.error, expected, label);
  }
  assert.deepEqual(counts(sqlite), ZERO, "no rejected payload may write anything");

  // The control: two distinct, well-formed source ids are accepted and get a row each. Without it,
  // every assertion above would still pass if the handler simply refused everything.
  const ok = await book(sqlite, { key: "order-ok", group: "SG-ORDER-OK", pets: [{ sourceId: "dup1", name: "A" }, { sourceId: "dup2", name: "B" }] });
  assert.equal(ok.status, 201);
  assert.equal(petsOf(sqlite).length, 2);
});

// --- the defect the identity work exists to fix ----------------------------------------------

test("a booking binds the pet the customer already saved instead of minting an empty duplicate", async () => {
  const sqlite = freshDb();
  await warmSchema(sqlite);

  // What the account flow stores: a real profile, keyed by its own account source id.
  sqlite.prepare("INSERT INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,source_pet_id,created_at,updated_at) VALUES ('PET-ACCOUNT',?,'Bruno','dog','Labrador Retriever','verified','account-9',1,1)").run(CUSTOMER);

  // What the booking flows send: the pet's NAME as its source id.
  const result = await book(sqlite, { key: "profile-1", group: "SG-PROFILE-1", pets: [{ sourceId: "Bruno", name: "Bruno", species: "dog" }] });
  assert.equal(result.status, 201);

  assert.deepEqual(petIdsOf(sqlite, "profile-1"), ["PET-ACCOUNT"], "the booking must point at the saved pet");
  const rows = petsOf(sqlite);
  assert.equal(rows.length, 1, "no second, empty row may be minted for a pet that already exists");
  assert.equal(rows[0].breed, "Labrador Retriever", "the stored profile must survive the booking");
  assert.equal(rows[0].vaccination_status, "verified");

  // The card reads pets through pet_ids_json — this is the query the route's own GET runs.
  // node:sqlite hands back null-prototype rows; spread them so the comparison is about the values.
  const shown = sqlite.prepare("SELECT id,name,breed,vaccination_status FROM canonical_pets WHERE customer_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY name")
    .all(CUSTOMER, sqlite.prepare("SELECT pet_ids_json FROM canonical_bookings WHERE idempotency_key='profile-1'").get().pet_ids_json)
    .map((row) => ({ ...row }));
  assert.deepEqual(shown, [{ id: "PET-ACCOUNT", name: "Bruno", breed: "Labrador Retriever", vaccination_status: "verified" }]);
});

test("a second pet of the same name keeps its own row rather than being absorbed", async () => {
  const sqlite = freshDb();
  await warmSchema(sqlite);

  // Two dogs, both called Bruno, each with its own account source id. Sharing a name is not sharing
  // an identity: binding the booking to the first one would record the wrong animal for the visit.
  sqlite.prepare("INSERT INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,source_pet_id,created_at,updated_at) VALUES ('PET-FIRST',?,'Bruno','dog','Labrador','verified','acct-1',1,1)").run(CUSTOMER);

  const result = await book(sqlite, { key: "same-name", group: "SG-SAME-NAME", pets: [{ sourceId: "acct-2", name: "Bruno", breed: "Beagle" }] });
  assert.equal(result.status, 201);

  const bound = petIdsOf(sqlite, "same-name");
  assert.notDeepEqual(bound, ["PET-FIRST"], "the new pet must not be absorbed into the existing one");
  assert.equal(petsOf(sqlite).length, 2, "each animal gets its own row");
  const first = sqlite.prepare("SELECT * FROM canonical_pets WHERE id='PET-FIRST'").get();
  assert.equal(first.breed, "Labrador", "the first dog's profile is untouched");
  const second = sqlite.prepare("SELECT * FROM canonical_pets WHERE id=?").get(bound[0]);
  assert.equal(second.breed, "Beagle", "the second dog keeps its own profile");
  assert.equal(second.source_pet_id, "acct-2");
});

test("a booking fills a blank profile field but never overwrites a stored one", async () => {
  const sqlite = freshDb();
  await warmSchema(sqlite);

  // Padding and casing are part of what the customer stored. A booking may fill a gap; it may not
  // rewrite, and it may not renormalize.
  sqlite.prepare("INSERT INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,source_pet_id,created_at,updated_at) VALUES ('PET-STORED',?,'  BrUnO  ','dog','  Labrador  ','not_provided','sid-1',1000,2000)").run(CUSTOMER);

  const result = await book(sqlite, { key: "fill-1", group: "SG-FILL-1", pets: [{ sourceId: "sid-1", name: "Overwrite me", species: "cat", breed: "Poodle", vaccinationStatus: "verified" }] });
  assert.equal(result.status, 201);

  const row = sqlite.prepare("SELECT * FROM canonical_pets WHERE id='PET-STORED'").get();
  assert.equal(row.name, "  BrUnO  ", "a stored name keeps its exact bytes");
  assert.equal(row.breed, "  Labrador  ", "a stored breed is neither overwritten nor trimmed");
  assert.equal(row.vaccination_status, "verified", "the blank sentinel is the one field the payload may fill");
  assert.equal(row.created_at, 1000);
  assert.notEqual(row.updated_at, 2000, "filling a genuine gap does move the timestamp");

  // ...and a booking that fills nothing leaves the row alone entirely, timestamp included.
  const untouched = sqlite.prepare("SELECT * FROM canonical_pets WHERE id='PET-STORED'").get();
  const second = await book(sqlite, { key: "fill-2", group: "SG-FILL-2", pets: [{ sourceId: "sid-1", name: "Overwrite me", breed: "Poodle", vaccinationStatus: "expired" }] });
  assert.equal(second.status, 201);
  assert.deepEqual(sqlite.prepare("SELECT * FROM canonical_pets WHERE id='PET-STORED'").get(), untouched, "a complete row must not see a phantom edit");
});
