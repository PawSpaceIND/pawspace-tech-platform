import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// ---------------------------------------------------------------------------
// POST /api/meet-and-greet is deliberately public — a customer must be able to ask a host for a meet &
// greet before they have signed in anywhere. What was not deliberate is that it took `customerId`, an
// internal identifier, straight from the request body and filed the request under it.
//
// Two things followed, and both are executed below against the REAL route handler:
//
//   an unauthenticated caller could file a request in a real customer's name; and
//   because only one open request may exist per customer+host, that impostor request LOCKED the real
//   customer out of requesting a meet & greet with that host at all.
//
// The route this one mirrors, /api/relocation-enquiry, asks for contact details and no internal id.
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

const VICTIM = "CUS-VICTIM-1";
const ORIGIN = "https://preview.pawspace.test";

function fresh() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db };
  return { sqlite, db };
}

/** A real host the route will accept, and a real customer for the spoof to aim at. */
async function world() {
  const { sqlite, db } = fresh();
  const capacity = await import("../lib/provider-capacity-governance.ts");
  await capacity.ensureProviderCapacityTables(db);
  await capacity.seedProviderCapacityDefaults(db);
  const meetGreet = await import("../lib/meet-and-greet.ts");
  await meetGreet.ensureMeetGreetTables(db);

  const host = sqlite.prepare("SELECT id FROM provider_capacity_profiles WHERE live=1 AND services_json LIKE '%pet_sitting%' LIMIT 1").get();
  assert.ok(host, "the capacity defaults must seed a pet-sitting host for this to mean anything");

  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'uat_customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(VICTIM, "blr", "Real Customer", "+919000000001", 1, 1);

  return { sqlite, db, hostId: String(host.id) };
}

/** A real customer session cookie, minted through the production session modules. */
async function customerSession(db, customerId) {
  const binding = await import("../lib/identity-binding.ts");
  const platform = await import("../lib/platform-session.ts");
  await binding.ensureIdentityBindingTables(db);
  const principalKey = `customer-${customerId}`;
  const created = await binding.upsertIdentityBinding(db, {
    identitySource: "customer_otp", principalType: "identity_subject", principalKey,
    subjectType: "customer", subjectId: customerId, cityId: "blr",
    actorId: "test", reason: "customer signed in",
  });
  const issued = await platform.issuePlatformSession(db, {
    bindingId: String(created.id), identitySource: "customer_otp", principalType: "identity_subject",
    principalKey, subjectType: "customer", subjectId: customerId, ttlSeconds: 3600,
  });
  return platform.platformSessionCookie(issued.token, issued.ttlSeconds).split(";")[0];
}

const futureSlot = () => {
  const at = new Date(Date.now() + 7 * 86400000);
  at.setUTCHours(6, 0, 0, 0); // ~11:30 IST — inside the house-visit window and comfortably future
  return at.getTime();
};

const post = async (body, cookie) => {
  const { POST } = await import("../app/api/meet-and-greet/route.ts");
  return POST(new Request(`${ORIGIN}/api/meet-and-greet`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  }));
};

const rows = (sqlite) => sqlite.prepare("SELECT id,customer_id,host_provider_id,status FROM meet_greet_requests").all();

// --- the defect ---------------------------------------------------------------------------------

test("NEGATIVE: an anonymous request cannot be filed in a real customer's name", async () => {
  const { sqlite, db, hostId } = await world();

  const response = await post({ customerId: VICTIM, hostProviderId: hostId, format: "phone", preferredAt: futureSlot() });
  assert.equal(response.status, 201, "the public enquiry path must still work");

  const stored = rows(sqlite);
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0].customer_id, VICTIM,
    "an unauthenticated caller must not be able to attach a request to a customer it has not proved it is");
  assert.match(String(stored[0].customer_id), /^MGENQ-/,
    "an anonymous enquiry gets its own unattributed id");
  assert.ok(db, "database handle retained");
});

test("NEGATIVE: the spoof cannot lock the real customer out of requesting with that host", async () => {
  // The sharper half. One open request is allowed per customer+host, so a request filed under the
  // victim's id is not merely noise — it consumes the victim's only slot with that host.
  const { sqlite, hostId, db } = await world();

  await post({ customerId: VICTIM, hostProviderId: hostId, format: "phone", preferredAt: futureSlot() });

  const cookie = await customerSession(db, VICTIM);
  const victimResponse = await post({ hostProviderId: hostId, format: "phone", preferredAt: futureSlot() + 3600000 }, cookie);
  assert.equal(victimResponse.status, 201, "the real customer must still be able to request their own meet & greet");

  const mine = rows(sqlite).filter((row) => row.customer_id === VICTIM);
  assert.equal(mine.length, 1, "and it is filed under them");
});

// --- the authenticated path ----------------------------------------------------------------------

test("a signed-in customer's request is filed under the session subject, not the body", async () => {
  const { sqlite, db, hostId } = await world();
  const cookie = await customerSession(db, VICTIM);

  const response = await post({ hostProviderId: hostId, format: "phone", preferredAt: futureSlot() }, cookie);
  assert.equal(response.status, 201);
  const stored = rows(sqlite);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].customer_id, VICTIM, "identity comes from the session");
});

test("NEGATIVE: a signed-in customer claiming another customer's id is refused, and nothing is written", async () => {
  const { sqlite, db, hostId } = await world();
  const cookie = await customerSession(db, VICTIM);

  const response = await post({ customerId: "CUS-SOMEONE-ELSE", hostProviderId: hostId, format: "phone", preferredAt: futureSlot() }, cookie);
  assert.equal(response.status, 403, "a mismatch is refused outright rather than quietly rewritten");
  const body = await response.json();
  assert.match(String(body.error), /your own account/);
  assert.deepEqual(rows(sqlite), [], "a refused request must write nothing");
});

test("a signed-in customer may still name their OWN id explicitly", async () => {
  const { sqlite, db, hostId } = await world();
  const cookie = await customerSession(db, VICTIM);

  const response = await post({ customerId: VICTIM, hostProviderId: hostId, format: "phone", preferredAt: futureSlot() }, cookie);
  assert.equal(response.status, 201, "naming yourself is not a mismatch");
  assert.equal(rows(sqlite)[0].customer_id, VICTIM);
});

// --- the public path is genuinely unchanged -------------------------------------------------------

test("the enquiry remains public: no session, no access code, still accepted", async () => {
  const { sqlite, hostId } = await world();
  const response = await post({ hostProviderId: hostId, format: "house_visit", preferredAt: futureSlot() });
  assert.equal(response.status, 201, "requiring a session here would have broken the customer-facing form");
  assert.equal(rows(sqlite).length, 1);
});

test("two anonymous enquiries for the same host do not collide with each other", async () => {
  // Each anonymous enquiry gets its own identity, so the one-open-request rule cannot be weaponised
  // between strangers either.
  const { sqlite, hostId } = await world();
  const first = await post({ hostProviderId: hostId, format: "phone", preferredAt: futureSlot() });
  const second = await post({ hostProviderId: hostId, format: "phone", preferredAt: futureSlot() + 7200000 });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201, "a stranger's enquiry must not block the next stranger's");
  const stored = rows(sqlite);
  assert.equal(stored.length, 2);
  assert.notEqual(stored[0].customer_id, stored[1].customer_id, "and they are distinct identities");
});

test("the route never reads customerId from the body for an unauthenticated caller", () => {
  // Stated against the source as a guard on the shape of the fix: the only customerId the anonymous
  // branch may use is one the server minted.
  const source = fs.readFileSync(new URL("../app/api/meet-and-greet/route.ts", import.meta.url), "utf8");
  const postSource = source.slice(source.indexOf("export async function POST"), source.indexOf("export async function GET"));
  assert.match(postSource, /resolvePlatformSession/, "the session is what decides identity");
  assert.match(postSource, /MGENQ-/, "an anonymous caller gets a minted enquiry id");
  assert.ok(!/customerId:\s*String\(body\.customerId/.test(postSource),
    "the claimed body id must never be passed through to the creator");
});
