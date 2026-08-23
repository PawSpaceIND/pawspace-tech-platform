import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// ---------------------------------------------------------------------------
// /api/uat-provider-switch mints a platform session for ANY live provider in the roster, with no prior
// provider session and no ownership check. That is the feature: a UAT tester switches provider identity
// to exercise the provider app. The only things standing between that and an arbitrary provider session
// are the environment gate and the shared access code — so those are what must be executed, not read.
//
// The pre-existing coverage asserted that the strings `uatLoginEnabled` and `uatAccessCodeValid` appear
// in the route source. That proves the call sites exist. It does not prove the gate REFUSES, that it
// refuses in the right order, or — the part that actually matters — that a refusal writes nothing.
// A route that mints the session and then checks the code would satisfy the regex test perfectly.
//
// Every case below drives the real GET/POST handlers and then reads the tables back.
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

const ORIGIN = "https://uat.pawspace.test";
const GOOD_KEY = "k".repeat(32);
const GOOD_CODE = "c".repeat(32);

/** The gate open, exactly as scripts/stage-config.mjs configures staging. */
const OPEN = { PAWSPACE_UAT_LOGIN: "on", PAWSPACE_UAT_SIGNING_KEY: GOOD_KEY, PAWSPACE_UAT_ACCESS_CODE: GOOD_CODE };

async function world(env) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db, ...env };
  const capacity = await import("../lib/provider-capacity-governance.ts");
  await capacity.ensureProviderCapacityTables(db);
  await capacity.seedProviderCapacityDefaults(db);
  const binding = await import("../lib/identity-binding.ts");
  await binding.ensureIdentityBindingTables(db);
  const platform = await import("../lib/platform-session.ts");
  await platform.ensurePlatformSessionTables(db);
  const live = sqlite.prepare("SELECT id FROM provider_capacity_profiles WHERE live=1 AND status='active' ORDER BY id").all();
  assert.ok(live.length >= 2, "the roster must seed at least two live providers for cross-provider cases to mean anything");
  return { sqlite, db, providerA: String(live[0].id), providerB: String(live[1].id) };
}

const post = async (body) => {
  const { POST } = await import("../app/api/uat-provider-switch/route.ts");
  return POST(new Request(`${ORIGIN}/api/uat-provider-switch`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify(body),
  }));
};

/** Everything the route is capable of writing. A refusal must leave all of it empty. */
const written = (sqlite) => ({
  bindings: sqlite.prepare("SELECT COUNT(*) n FROM identity_bindings WHERE principal_key LIKE 'uat-provider:%'").get().n,
  audit: sqlite.prepare("SELECT COUNT(*) n FROM identity_binding_audit").get().n,
  // Queried directly, with the table guaranteed to exist by world(). An earlier draft of this helper
  // named the table wrongly and swallowed the error as 0, so every "nothing was written" assertion
  // passed for the wrong reason. The success-path test below asserts this counter reaches 1.
  sessions: sqlite.prepare("SELECT COUNT(*) n FROM platform_identity_sessions").get().n,
});

const NOTHING = { bindings: 0, audit: 0, sessions: 0 };

// --- the environment gate ------------------------------------------------------------------------

test("with no UAT environment at all the switch does not exist", async () => {
  const { sqlite, providerB } = await world({});
  const response = await post({ providerId: providerB, code: GOOD_CODE });
  assert.equal(response.status, 404, "production has none of these variables set");
  assert.deepEqual(written(sqlite), NOTHING, "a 404 must not have minted anything on the way out");
});

test("the roster itself is not readable without the gate", async () => {
  // The GET enumerates every live provider id and city. That is a roster, and it is the input a switch
  // needs, so it is gated by the same flag rather than left open as 'just a list'.
  await world({});
  const { GET } = await import("../app/api/uat-provider-switch/route.ts");
  const response = await GET();
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.providers, undefined);
  assert.equal(body.data, undefined, "no roster leaks through the refusal body");
});

test("NEGATIVE: the flag alone does not open the gate — a short signing key keeps it shut", async () => {
  // uatLoginEnabled requires the flag AND a key at the same 32-character floor the deploy enforces, so
  // a key too weak to deploy cannot be honoured if it reaches the worker by some other route.
  const { sqlite, providerB } = await world({ PAWSPACE_UAT_LOGIN: "on", PAWSPACE_UAT_SIGNING_KEY: "k".repeat(31), PAWSPACE_UAT_ACCESS_CODE: GOOD_CODE });
  const response = await post({ providerId: providerB, code: GOOD_CODE });
  assert.equal(response.status, 404, "one character below the floor is off, not 'on with a weak key'");
  assert.deepEqual(written(sqlite), NOTHING);
});

test("NEGATIVE: an unset access code refuses every code rather than accepting any", async () => {
  // The sharpest fail-closed case. An absent credential compared with String(code||"") would make ""
  // match "" — an unconfigured deployment that hands out provider sessions to anyone who omits the field.
  const { sqlite, providerB } = await world({ PAWSPACE_UAT_LOGIN: "on", PAWSPACE_UAT_SIGNING_KEY: GOOD_KEY });
  for (const attempt of [{ providerId: providerB }, { providerId: providerB, code: "" }, { providerId: providerB, code: GOOD_CODE }]) {
    const response = await post(attempt);
    assert.equal(response.status, 401, `unconfigured code must refuse ${JSON.stringify(attempt)}`);
  }
  assert.deepEqual(written(sqlite), NOTHING);
});

test("NEGATIVE: a wrong access code is refused, and refused BEFORE anything is minted", async () => {
  const { sqlite, providerB } = await world(OPEN);
  const response = await post({ providerId: providerB, code: "c".repeat(31) + "x" });
  assert.equal(response.status, 401);
  assert.deepEqual(written(sqlite), NOTHING, "ordering is the point: no binding, no audit row, no session");
  assert.equal(response.headers.get("set-cookie"), null, "and no session cookie handed back");
});

test("NEGATIVE: a valid code does not conjure a provider that is not in the live roster", async () => {
  const { sqlite } = await world(OPEN);
  const response = await post({ providerId: "prov-does-not-exist", code: GOOD_CODE });
  assert.equal(response.status, 404);
  assert.deepEqual(written(sqlite), NOTHING, "the identity is not created speculatively before the roster check");
});

test("NEGATIVE: a cross-origin write is blocked before the code is even considered", async () => {
  const { sqlite, providerB } = await world(OPEN);
  const { POST } = await import("../app/api/uat-provider-switch/route.ts");
  const response = await POST(new Request(`${ORIGIN}/api/uat-provider-switch`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://attacker.test" },
    body: JSON.stringify({ providerId: providerB, code: GOOD_CODE }),
  }));
  assert.equal(response.status, 403);
  assert.deepEqual(written(sqlite), NOTHING);
});

// --- with the gate open, what the feature actually does --------------------------------------------

test("with the gate open the switch mints a session for exactly the requested provider", async () => {
  const { sqlite, db, providerB } = await world(OPEN);
  const response = await post({ providerId: providerB, code: GOOD_CODE });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.providerId, providerB);
  assert.match(String(response.headers.get("set-cookie")), /^pawspace_identity_session=/, "a platform session cookie is returned");
  assert.deepEqual(written(sqlite), { bindings: 1, audit: 1, sessions: 1 },
    "and the counters the refusal cases assert are zero do reach one here — they are not vacuous");

  const rows = sqlite.prepare("SELECT principal_key,subject_type,subject_id FROM identity_bindings WHERE principal_key LIKE 'uat-provider:%'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subject_id, providerB, "the session subject is the requested provider and nothing wider");
  assert.equal(rows[0].subject_type, "provider");
  assert.ok(db, "database handle retained");
});

test("the switch writes into its own principal namespace and leaves a real provider's OTP identity intact", async () => {
  // The switch upserts on (identity_source, principal_type, principal_key, subject_type). If it shared a
  // principal key with the real partner-OTP binding it would REBIND that row — a UAT tester could evict
  // or repoint a genuine provider identity. It does not: 'uat-provider:<id>' is a distinct namespace.
  const { sqlite, db, providerB } = await world(OPEN);
  const binding = await import("../lib/identity-binding.ts");
  const real = await binding.upsertIdentityBinding(db, {
    identitySource: "partner_otp", principalType: "identity_subject", principalKey: "+919000000042",
    subjectType: "provider", subjectId: providerB, cityId: "blr", actorId: "otp", reason: "real provider signed in",
  });

  await post({ providerId: providerB, code: GOOD_CODE });

  const after = sqlite.prepare("SELECT id,principal_key,subject_id,status FROM identity_bindings WHERE id=?").get(String(real.id));
  assert.equal(after.principal_key, "+919000000042", "the real binding's principal is untouched");
  assert.equal(after.subject_id, providerB);
  assert.equal(after.status, "active", "and it is not revoked or repointed by the switch");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM identity_bindings").get().n, 2, "the switch added its own row rather than rewriting one");
});

test("NEGATIVE: switching to B does not touch B's bookings, work orders or assignments", async () => {
  // The decisive question for this route: is it a cross-provider WRITE, or only an identity mint? It
  // takes no bookingId, and nothing owned by the provider moves.
  const { sqlite, providerA, providerB } = await world(OPEN);
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,provider_id TEXT,customer_id TEXT,status TEXT,updated_at INTEGER)");
  sqlite.prepare("INSERT INTO canonical_bookings (id,provider_id,customer_id,status,updated_at) VALUES (?,?,?,?,?)")
    .run("BKG-OWNED-BY-B", providerB, "CUS-1", "confirmed", 1);

  const before = sqlite.prepare("SELECT * FROM canonical_bookings").all();
  const response = await post({ providerId: providerB, code: GOOD_CODE });
  assert.equal(response.status, 200);
  assert.deepEqual(sqlite.prepare("SELECT * FROM canonical_bookings").all(), before,
    "a provider switch reassigns no work — it is an identity mint, not a booking mutation");
  assert.ok(providerA, "two providers were resolved");
});

test("NEGATIVE: the route offers no way to name a booking or a second provider", async () => {
  // Extra fields are ignored rather than acted on. If the handler ever grows a bookingId parameter this
  // goes red, which is the point of asserting it against the running route rather than the source.
  const { sqlite, providerA, providerB } = await world(OPEN);
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,provider_id TEXT,customer_id TEXT,status TEXT,updated_at INTEGER)");
  sqlite.prepare("INSERT INTO canonical_bookings (id,provider_id,customer_id,status,updated_at) VALUES (?,?,?,?,?)")
    .run("BKG-OWNED-BY-B", providerB, "CUS-1", "confirmed", 1);

  const response = await post({ providerId: providerA, code: GOOD_CODE, bookingId: "BKG-OWNED-BY-B", targetProviderId: providerB, reassignTo: providerA });
  assert.equal(response.status, 200, "the recognised field still works");
  const booking = sqlite.prepare("SELECT provider_id FROM canonical_bookings WHERE id=?").get("BKG-OWNED-BY-B");
  assert.equal(booking.provider_id, providerB, "B keeps the booking; the extra fields did nothing");
  const rows = sqlite.prepare("SELECT subject_id FROM identity_bindings WHERE principal_key LIKE 'uat-provider:%'").all();
  assert.deepEqual(rows.map((r) => r.subject_id), [providerA], "only the provider named in providerId was minted");
});
