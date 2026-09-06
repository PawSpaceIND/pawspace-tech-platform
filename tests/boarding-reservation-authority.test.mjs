import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// ---------------------------------------------------------------------------
// Issue #197 item 4 — Boarding vaccination and ownership authority, executed.
//
// The client sends a vaccination status alongside the booking. That value is not authoritative, and the
// question that matters is not "does the server look at it" but "does the server decide BEFORE it
// reserves capacity". A check that runs after reservation still lets a modified client hold a slot for
// another customer's pet, or for a pet with no verified vaccination, until something else cleans it up.
//
// tests/booking-state-integrity.test.mjs asserts the mobile flow SENDS persisted truth. That is the
// client half. This drives the real /api/uat-scheduling handler and reads scheduling_reservations back,
// which is the half that actually governs capacity.
// ---------------------------------------------------------------------------

const WORKERS_SHIM = `export const env = new Proxy({}, { get: (_, key) => globalThis.__PAWSPACE_TEST_ENV?.[key] });`;
const workersUrl = `data:text/javascript,${encodeURIComponent(WORKERS_SHIM)}`;

if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `const workersUrl=${JSON.stringify(workersUrl)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); },
  };
}

const ORIGIN = "https://uat.pawspace.in";
const OWNER = "CUS-OWNER";
const STRANGER = "CUS-STRANGER";

/** A boarding-capable roster plus canonical pets in three distinct authority states. */
async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db, PAWSPACE_SCHEDULING_ENV: "uat" };

  const capacity = await import("../lib/provider-capacity-governance.ts");
  await capacity.ensureProviderCapacityTables(db);
  await capacity.seedProviderCapacityDefaults(db);
  await provisionOps(sqlite, db);

  const now = Date.now();
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,name TEXT NOT NULL,species TEXT NOT NULL,breed TEXT,vaccination_status TEXT NOT NULL DEFAULT 'not_provided',source_pet_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  const pet = (id, customerId, status) => sqlite
    .prepare("INSERT INTO canonical_pets (id,customer_id,name,species,vaccination_status,created_at,updated_at) VALUES (?,?,?,'dog',?,?,?)")
    .run(id, customerId, id, status, now, now);
  pet("PET-VERIFIED", OWNER, "verified");
  pet("PET-UNVERIFIED", OWNER, "not_provided");
  pet("PET-PENDING", OWNER, "pending");
  pet("PET-SOMEONE-ELSE", STRANGER, "verified");
  return { sqlite, db };
}

const future = () => {
  const start = new Date(Date.now() + 9 * 86_400_000);
  start.setUTCHours(5, 30, 0, 0); // pinned to a roster hour, as the scheduling suites do
  const end = new Date(start.getTime() + 24 * 3_600_000);
  return { start: start.toISOString(), end: end.toISOString() };
};

let sequence = 0;
// Boarding is host-selected: auto-assignment is disabled, so a real host must be named. host_maya_rohan
// is the seeded live blr/blr-east boarding host.
const HOST = "host_maya_rohan";

async function reserve({ customerId = OWNER, petIds }) {
  const { POST } = await import("../app/api/uat-scheduling/route.ts");
  const { start, end } = future();
  sequence += 1;
  return POST(new Request(`${ORIGIN}/api/uat-scheduling`, {
    method: "POST",
    headers: {
      "content-type": "application/json", origin: ORIGIN,
      "oai-authenticated-user-email": "ops@pawspace.in", "oai-authenticated-user-full-name": "Ops",
    },
    body: JSON.stringify({
      clientRequestId: `boarding-authority-${sequence}`, customerId, petIds,
      serviceCode: "boarding", cityId: "blr", zoneId: "blr-east",
      preferredProviderId: HOST, scheduledStart: start, scheduledEnd: end,
    }),
  }));
}

/**
 * An ops identity holding scheduling.book plus bookings.manage. The second grant matters: staff with
 * bookings.manage clear requireCustomerOwnership, which runs BEFORE the boarding pet gate. Without it
 * every case below would stop at "Customer ownership denied" and prove nothing about vaccination or pet
 * ownership — the tests would pass for the wrong reason. This isolates the gate under test.
 */
async function provisionOps(sqlite, db) {
  const auth = await import("../lib/server-auth.ts");
  await auth.ensureSecurityTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT OR REPLACE INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES (?,?,?,?,0,?)")
    .run("ops_scheduler", "Ops scheduler", "Books scheduling capacity", JSON.stringify(["scheduling.book", "scheduling.view", "bookings.manage"]), now);
  sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
    .run("u_ops", "ops@pawspace.in", "Ops", "ops_scheduler", now, now);
}

test("public Boarding host discovery works before the first canonical booking table exists", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db };
  const { discoverBoardingHosts } = await import("../lib/boarding-host-discovery.ts");
  const hosts = await discoverBoardingHosts(db, {
    cityId: "blr",
    zoneId: "blr-east",
    scheduledStart: "2026-09-03T10:00:00+05:30",
    scheduledEnd: "2026-09-06T10:00:00+05:30",
    petCount: 1,
    species: ["dog"],
  });
  assert.ok(hosts.length > 0, "a cold UAT database still exposes eligible governed hosts");
  assert.equal(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='canonical_bookings'").get(), undefined,
    "public discovery remains a read and does not create canonical booking storage");
});

const reservations = (sqlite) => {
  try { return sqlite.prepare("SELECT id,customer_id,pet_ids_json,status FROM scheduling_reservations").all(); }
  catch { return []; } // the table only exists once something actually reserved
};

// --- the authority gate -------------------------------------------------------------------------------

test("an owned, verified pet may reserve Boarding capacity", async () => {
  const { sqlite } = await world();
  const response = await reserve({ petIds: ["PET-VERIFIED"] });
  const body = await response.json();
  assert.equal(response.status < 400, true, `owned + verified must be allowed: ${JSON.stringify(body)}`);
  assert.ok(reservations(sqlite).length > 0, "capacity is actually reserved on the happy path — so the refusals below mean something");
});

test("NEGATIVE: an unverified pet is refused BEFORE any capacity is held", async () => {
  const { sqlite } = await world();
  const response = await reserve({ petIds: ["PET-UNVERIFIED"] });
  assert.equal(response.status, 409);
  assert.match(String((await response.json()).error), /verified vaccination/i);
  assert.deepEqual(reservations(sqlite), [], "a refused booking must leak no reservation");
});

test("NEGATIVE: a pending vaccination is not treated as verified", async () => {
  // "unknown" and "in progress" are not "verified". Only the literal verified state may pass.
  const { sqlite } = await world();
  const response = await reserve({ petIds: ["PET-PENDING"] });
  assert.equal(response.status, 409);
  assert.deepEqual(reservations(sqlite), []);
});

test("NEGATIVE: another customer's pet is refused BEFORE any capacity is held", async () => {
  const { sqlite } = await world();
  const response = await reserve({ customerId: OWNER, petIds: ["PET-SOMEONE-ELSE"] });
  assert.equal(response.status, 403, "ownership is decided from canonical_pets, not from the request");
  assert.match(String((await response.json()).error), /ownership/i);
  assert.deepEqual(reservations(sqlite), [], "no capacity is held for a pet the caller does not own");
});

test("NEGATIVE: a pet that does not exist at all is refused", async () => {
  const { sqlite } = await world();
  const response = await reserve({ petIds: ["PET-DOES-NOT-EXIST"] });
  assert.equal(response.status, 403);
  assert.deepEqual(reservations(sqlite), []);
});

test("NEGATIVE: one bad pet in a multi-pet booking refuses the whole reservation", async () => {
  // Partial acceptance would be the worst outcome: capacity held, and a pet in the stay that nobody
  // verified. The gate runs over every selected pet before anything is reserved.
  const { sqlite } = await world();
  const response = await reserve({ petIds: ["PET-VERIFIED", "PET-UNVERIFIED"] });
  assert.equal(response.status, 409);
  assert.deepEqual(reservations(sqlite), [], "no partial reservation is created for the acceptable pet");
});

test("NEGATIVE: with no canonical pet records at all, Boarding refuses rather than assuming", async () => {
  // Fail-closed when the authority source is absent, instead of trusting the client-sent status.
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db, PAWSPACE_SCHEDULING_ENV: "uat" };
  const capacity = await import("../lib/provider-capacity-governance.ts");
  await capacity.ensureProviderCapacityTables(db);
  await capacity.seedProviderCapacityDefaults(db);
  await provisionOps(sqlite, db);

  const response = await reserve({ petIds: ["PET-VERIFIED"] });
  assert.equal(response.status, 409, "absent canonical pet records must not be read as 'fine'");
  assert.match(String((await response.json()).error), /canonical pet records/i);
  assert.deepEqual(reservations(sqlite), []);
});
