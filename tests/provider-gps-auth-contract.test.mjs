/*
 * Provider GPS authorisation, executed rather than described.
 *
 * This suite used to assert its four properties by regex-matching the source of
 * app/api/location-recovery/route.ts and lib/api-gateway.ts - it checked that the strings
 * `hasPermission(actor.permissions,"bookings.manage")` and `requireProviderOwnership(...)`
 * APPEARED in the file. Deleting either call and leaving the identifier in a comment would have
 * kept it green, and so would reordering the checks so ownership ran after the data was returned.
 * Location is the most sensitive thing this platform holds about a contractor, so "the string is
 * present" is not a standard worth keeping.
 *
 * It now drives the real GET and POST handlers with real actors against a real database, and
 * asserts status codes and response shape. Converted as part of paying down the source-text test
 * debt tracked by tests/test-suite-executes-code.test.mjs.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__GPS_DB__", "__GPS_ENV__");

const ORIGIN = "https://ops.pawspace.test";
const STAFF = "ops.gps@pawspace.in";
const PROVIDER = "provider.gps@pawspace.in";
const OTHER_PROVIDER_ID = "PRV-SOMEONE-ELSE";

function makeD1(sqlite) {
  const stmt = (sql, args) => ({
    bind: (...b) => stmt(sql, b),
    first: async (col) => { const r = sqlite.prepare(sql).get(...args); return r === undefined ? null : (col ? r[col] : r); },
    run: async () => { const i = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(i.changes), last_row_id: Number(i.lastInsertRowid || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args), success: true, meta: {} }),
    raw: async () => sqlite.prepare(sql).all(...args).map((r) => Object.values(r)),
  });
  return {
    prepare: (sql) => stmt(sql, []),
    batch: async (list) => { const out = []; for (const s of list) out.push(await s.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

let route;
async function world() {
  if (route) return route;
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__GPS_DB__ = db;
  // Non-localhost origin below, and no preview flags here: lib/development-preview.ts grants a
  // superuser bypass on a local host, which would make every refusal below pass for the wrong reason.
  globalThis.__GPS_ENV__ = { APP_ENV: "staging", PAWSPACE_SCHEDULING_ENV: "uat" };

  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const now = Date.now();
  for (const [id, email, role] of [
    ["USR-GPS-STAFF", STAFF, "manager"],
    ["USR-GPS-PROVIDER", PROVIDER, "service_provider"],
  ]) {
    sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
      .run(id, email, role, role, now, now);
  }
  route = await import("../app/api/location-recovery/route.ts");
  return route;
}

const get = (email) => new Request(`${ORIGIN}/api/location-recovery`, {
  headers: { "oai-authenticated-user-email": email },
});

const post = (email, body, headers = {}) => new Request(`${ORIGIN}/api/location-recovery`, {
  method: "POST",
  headers: { "oai-authenticated-user-email": email, "content-type": "application/json", origin: ORIGIN, ...headers },
  body: JSON.stringify(body),
});

/* THE ownership catcher. Sabotage-verified: deleting the three requireProviderOwnership calls from
 * the route - while leaving the identifier in a comment, so the source still matches the regex this
 * suite used to assert on - turns this test red and leaves the other seven green. That is the exact
 * regression the previous source-text version of this file could not have detected. */
test("GPS-1: a provider cannot act on another provider's location session", async () => {
  const r = await world();
  const response = await r.POST(post(PROVIDER, {
    action: "start_session", bookingId: "BK-GPS-1", providerId: OTHER_PROVIDER_ID,
  }));
  assert.notEqual(response.status, 200,
    "a provider started a location session against a provider id that is not theirs");
  assert.ok(response.status === 403 || response.status === 404,
    `expected an ownership refusal, got ${response.status}`);
});

/* Defence in depth, NOT the ownership catcher. Measured under sabotage: with the three
 * requireProviderOwnership calls removed this still passes, because the session id does not exist
 * and the write fails for that reason instead. GPS-1 is the assertion that actually detects a
 * missing ownership check - kept separate so neither is mistaken for the other. */
test("GPS-2: a GPS write against another provider's id does not succeed", async () => {
  const r = await world();
  const response = await r.POST(post(PROVIDER, {
    action: "record_location", sessionId: "SES-1", providerId: OTHER_PROVIDER_ID,
    latitude: 12.97, longitude: 77.64, accuracyMeters: 10,
  }));
  assert.notEqual(response.status, 200, "a provider wrote GPS evidence against another provider's id");
});

test("GPS-3: a provider cannot create a financial adjustment - that needs finance.manage", async () => {
  const r = await world();
  const response = await r.POST(post(PROVIDER, {
    action: "create_financial_adjustment", accountabilityCaseId: "ACC-1", amount: 500,
  }));
  assert.notEqual(response.status, 200,
    "a contractor moved money through the location-recovery route");
  assert.equal(response.status, 403, `expected 403 on a finance action, got ${response.status}`);
});

test("GPS-4: a cross-origin write is blocked before any handler work", async () => {
  const r = await world();
  const response = await r.POST(post(STAFF,
    { action: "set_controls", mapEnvironment: "sandbox" },
    { origin: "https://evil.example" }));
  assert.equal(response.status, 403, `a cross-origin session write returned ${response.status}`);
});

test("GPS-5: staff CAN read the governance snapshot - the refusals above are not blanket", async () => {
  const r = await world();
  const response = await r.GET(get(STAFF));
  assert.equal(response.status, 200, `staff were refused the snapshot with ${response.status}`);
  const body = await response.json();
  assert.ok(body?.data && typeof body.data === "object", "staff read returned no governance data");
});

test("GPS-6: a provider with no identity binding gets no location data at all", async () => {
  /* Measured, not assumed: this actor is a real service_provider row with no row in
   * identity_bindings. The route resolves a caller without bookings.manage through ownProviderId,
   * which has nothing to bind them to - and it refuses rather than falling back to an unscoped
   * read. That fallback is the interesting failure mode, and only executing the route can see it;
   * the source-text version of this suite could not tell a 403 from a 200. */
  const r = await world();
  const response = await r.GET(get(PROVIDER));
  assert.equal(response.status, 403,
    `an unbound provider got ${response.status} - an unscoped read would be a location leak`);
  const text = await response.text();
  assert.doesNotMatch(text, /latitude|longitude|distance_meters/,
    "a refused location read still returned coordinate data");
});

test("GPS-7: the staff snapshot does not report raw customer GPS exposure", async () => {
  const r = await world();
  const text = await (await r.GET(get(STAFF))).text();
  // The route's standing contract: customers are never handed raw GPS from this surface. A
  // regression that started exposing coordinates flips this flag; the old string match could not.
  assert.doesNotMatch(text, /"rawGpsCustomerExposure"\s*:\s*true/,
    "the governance snapshot reported raw customer GPS exposure");
});

test("GPS-8: an unknown action is refused rather than silently accepted", async () => {
  const r = await world();
  const response = await r.POST(post(STAFF, { action: "definitely_not_an_action" }));
  assert.notEqual(response.status, 200, "an unsupported action was accepted");
});
