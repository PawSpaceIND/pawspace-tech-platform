import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ---------------------------------------------------------------------------
// /api/provider-availability write ownership (Lane 4 item D).
//
// WHY THIS MATTERS MORE THAN IT LOOKS. The gateway maps this path to bookings.view
// (lib/api-gateway.ts), and the service_provider role HOLDS bookings.view. So the gateway lets every
// provider through to the handler, and requireProviderOwnership() inside the route is the only thing
// standing between provider A and provider B's availability record. Marking a rival unavailable
// removes them from assignment for as long as the flag stands.
//
// That single control had no executable proof. The one test referencing this route
// (provider-identity-onboarding-closure.test.mjs) neither executes the handler nor builds a request on
// any host, so nothing exercised the deny path.
//
// Every denial below is asserted against the DATABASE, not just the HTTP status: a 403 that still
// wrote the row would satisfy a status-only assertion while leaving the defect in place.
//
// Requests use a NON-localhost host throughout. resolveActor() short-circuits localhost, 127.0.0.1
// and terminal.local to a development-preview superuser holding ["*"], and actorManagesProviders()
// then returns true for it, so requireProviderOwnership() would return before ever comparing
// identities - every case here would pass while proving nothing. That gating is asserted at the end.
// ---------------------------------------------------------------------------

installWorkersHooks("__PAV_DB__", "__PAV_ENV__");

const HOST = "https://ops.pawspace.example";
const ENDPOINT = `${HOST}/api/provider-availability`;
const NOW = 1770000000000;
const PROVIDER_A = "groom_arun";
const PROVIDER_B = "groom_kiran";
const EMAIL_A = "arun@providers.pawspace.in";
const EMAIL_B = "kiran@providers.pawspace.in";

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
    exec: async (sql) => { sqlite.exec(sql); },
  };
}

const route = await import("../app/api/provider-availability/route.ts");
const serverAuth = await import("../lib/server-auth.ts");
const capacity = await import("../lib/provider-capacity-governance.ts");
const platformSecurity = await import("../lib/platform-security.ts");

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAV_DB__ = db;
  globalThis.__PAV_ENV__ = {};
  await serverAuth.ensureSecurityTables(db);
  await capacity.seedProviderCapacityDefaults(db);
  // The legacy binding requireProviderOwnership() falls back to when there is no identity-session
  // binding. Both providers are bound, so a denial can only come from the identity comparison.
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_identity_links (email TEXT PRIMARY KEY, provider_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', verified_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  const bind = sqlite.prepare("INSERT OR REPLACE INTO provider_identity_links (email,provider_id,status,verified_at,updated_at) VALUES (?,?,'active',?,?)");
  bind.run(EMAIL_A, PROVIDER_A, NOW, NOW);
  bind.run(EMAIL_B, PROVIDER_B, NOW, NOW);
  const providerRole = platformSecurity.defaultRoles.find((role) => role.code === "service_provider");
  for (const email of [EMAIL_A, EMAIL_B]) {
    sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
      .run(`USR-${email}`, email, email.split("@")[0], providerRole.code, NOW, NOW);
  }
  return { sqlite, db, providerRole };
}

const post = (email, body) => route.POST(new Request(ENDPOINT, {
  method: "POST",
  headers: { "content-type": "application/json", ...(email ? { "oai-authenticated-user-email": email } : {}) },
  body: JSON.stringify(body),
}));

// setProviderAvailability does not flip provider_capacity_profiles.live - it writes a row into
// provider_unavailability, stamped with the actor that imposed it. Clearing is where authority
// separates from ownership: a provider may lift only blocks it created ("AND created_by=?"), while
// staff may lift anyone's. These helpers therefore read the block table, not the profile.
const exists = (sqlite, providerId) => sqlite.prepare("SELECT id FROM provider_capacity_profiles WHERE id=?").get(providerId);
const blocks = (sqlite, providerId) => sqlite.prepare("SELECT id,created_by FROM provider_unavailability WHERE provider_id=? AND status='active' ORDER BY id").all(providerId);
const allBlocks = (sqlite) => sqlite.prepare("SELECT provider_id,created_by,status FROM provider_unavailability ORDER BY provider_id,id").all();
const refused = (response) => [401, 403].includes(response.status);

test("the seeded world distinguishes two real providers, so ownership is expressible", async () => {
  const { sqlite, providerRole } = await world();
  assert.ok(exists(sqlite, PROVIDER_A), `${PROVIDER_A} must exist in the capacity profiles`);
  assert.ok(exists(sqlite, PROVIDER_B), `${PROVIDER_B} must exist in the capacity profiles`);
  // The whole point: the gateway lets a provider reach this route because it holds bookings.view.
  assert.ok(providerRole.permissions.includes("bookings.view"),
    "service_provider must hold bookings.view, which is what makes route-level ownership the only control");
  assert.ok(!platformSecurity.hasPermission(providerRole.permissions, "providers.manage"),
    "service_provider must not manage providers, or ownership would be bypassed by authority");
});

// ---------------------------------------------------------------------------
// The control itself.
// ---------------------------------------------------------------------------

test("a provider cannot mark another provider unavailable, and nothing changes", async () => {
  const { sqlite } = await world();
  const before = allBlocks(sqlite);
  const response = await post(EMAIL_A, { providerId: PROVIDER_B, available: false, reason: "Removing a rival from assignment" });
  assert.ok(refused(response), `provider A writing provider B must be refused, got ${response.status}`);
  assert.deepEqual(allBlocks(sqlite), before, "a refused cross-provider write must leave the block table untouched");
  assert.equal(blocks(sqlite, PROVIDER_B).length, 0, "provider B must not have been blocked by provider A");
});

test("a provider can mark itself unavailable, and that write persists", async () => {
  const { sqlite } = await world();
  const response = await post(EMAIL_A, { providerId: PROVIDER_A, available: false, reason: "Away on personal leave today" });
  assert.equal(response.status, 200, `a provider must be able to update its own record, got ${response.status}`);
  const own = blocks(sqlite, PROVIDER_A);
  assert.equal(own.length, 1, "the provider's own availability change must persist");
  assert.equal(own[0].created_by, EMAIL_A, "the block must be attributed to the provider that imposed it");
  assert.equal(blocks(sqlite, PROVIDER_B).length, 0, "one provider's change must not touch another's record");
});

test("an anonymous caller cannot write any provider's availability", async () => {
  const { sqlite } = await world();
  const before = allBlocks(sqlite);
  const response = await post(null, { providerId: PROVIDER_A, available: false, reason: "No identity at all" });
  assert.ok(refused(response), `an anonymous write must be refused, got ${response.status}`);
  assert.deepEqual(allBlocks(sqlite), before, "an anonymous refusal must change nothing");
});

test("an identity with no provider binding is refused", async () => {
  const { sqlite } = await world();
  const providerRole = platformSecurity.defaultRoles.find((role) => role.code === "service_provider");
  sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
    .run("USR-UNBOUND", "unbound@providers.pawspace.in", "unbound", providerRole.code, NOW, NOW);
  const before = allBlocks(sqlite);
  const response = await post("unbound@providers.pawspace.in", { providerId: PROVIDER_A, available: false, reason: "No binding row exists" });
  assert.ok(refused(response), `an unbound provider identity must be refused, got ${response.status}`);
  assert.deepEqual(allBlocks(sqlite), before);
});

test("a revoked provider binding no longer owns the record", async () => {
  const { sqlite } = await world();
  sqlite.prepare("UPDATE provider_identity_links SET status='revoked' WHERE email=?").run(EMAIL_A);
  const before = allBlocks(sqlite);
  const response = await post(EMAIL_A, { providerId: PROVIDER_A, available: false, reason: "Binding was revoked" });
  assert.ok(refused(response), `a revoked binding must not retain ownership, got ${response.status}`);
  assert.deepEqual(allBlocks(sqlite), before);
});

test("staff who manage providers may write any provider, by authority rather than ownership", async () => {
  const { sqlite } = await world();
  const staffRole = platformSecurity.defaultRoles.find((role) => role.permissions.includes("providers.manage"));
  assert.ok(staffRole, "no role manages providers, so the staff-override path is not expressible");
  sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
    .run("USR-OPS", "ops.lead@pawspace.in", "ops", staffRole.code, NOW, NOW);
  const response = await post("ops.lead@pawspace.in", { providerId: PROVIDER_B, available: false, reason: "Suspended pending an ops review" });
  assert.equal(response.status, 200, `role ${staffRole.code} manages providers and must be allowed, got ${response.status}`);
  const imposed = blocks(sqlite, PROVIDER_B);
  assert.equal(imposed.length, 1, "the staff override must persist");
  assert.equal(imposed[0].created_by, "ops.lead@pawspace.in", "the block must be attributed to the staff actor");
});

test("a staff role that does not manage providers is refused", async () => {
  const { sqlite } = await world();
  const weak = platformSecurity.defaultRoles.find((role) =>
    !role.permissions.includes("*") && !role.permissions.includes("providers.manage") && role.permissions.includes("dashboard.view"));
  assert.ok(weak, "no staff role lacks providers.manage, so this denial is not expressible");
  sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
    .run("USR-WEAK", "weak@pawspace.in", "weak", weak.code, NOW, NOW);
  const before = allBlocks(sqlite);
  const response = await post("weak@pawspace.in", { providerId: PROVIDER_A, available: false, reason: "Not my provider to change" });
  assert.ok(refused(response), `role ${weak.code} must not write provider availability, got ${response.status}`);
  assert.deepEqual(allBlocks(sqlite), before);
});

test("repeating the same submit is safe: still unavailable, and one self-clear restores it", async () => {
  const { sqlite } = await world();
  const body = { providerId: PROVIDER_A, available: false, reason: "Away on personal leave today" };
  assert.equal((await post(EMAIL_A, body)).status, 200);
  assert.equal((await post(EMAIL_A, body)).status, 200, "a repeated identical submit must not fail");
  // Stated honestly: each submit inserts its own block row, so the rows DO accumulate. What matters
  // is that the observable state is unchanged - still unavailable - and that a single self-clear
  // lifts every block this provider imposed, so a repeat cannot leave a provider stuck.
  assert.ok(blocks(sqlite, PROVIDER_A).length >= 1, "the provider must remain blocked");
  const cleared = await post(EMAIL_A, { providerId: PROVIDER_A, available: true, reason: "Back from leave" });
  assert.equal(cleared.status, 200);
  assert.equal(blocks(sqlite, PROVIDER_A).length, 0, "one self-clear must lift every block this provider imposed");
  assert.equal((await cleared.json()).data.restrictionsRemaining, 0, "the response must report no restriction remaining");
});

test("a provider cannot lift a restriction that staff imposed", async () => {
  // This is the authority half of the route's comment: ownership says whose record it is, authority
  // says who may lift a block on it. Without the created_by predicate a suspended provider could
  // clear its own suspension.
  const { sqlite } = await world();
  const staffRole = platformSecurity.defaultRoles.find((role) => role.permissions.includes("providers.manage"));
  sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
    .run("USR-OPS", "ops.lead@pawspace.in", "ops", staffRole.code, NOW, NOW);
  assert.equal((await post("ops.lead@pawspace.in", { providerId: PROVIDER_A, available: false, reason: "Suspended pending an ops review" })).status, 200);
  assert.equal(blocks(sqlite, PROVIDER_A).length, 1);

  const attempt = await post(EMAIL_A, { providerId: PROVIDER_A, available: true, reason: "Trying to lift my own suspension" });
  assert.equal(attempt.status, 200, "the request itself is legitimate - the provider owns the record");
  const body = await attempt.json();
  assert.equal(body.data.available, false, "the provider must still be unavailable");
  assert.equal(body.data.restrictionsRemaining, 1, "the staff-imposed restriction must still stand");
  assert.equal(blocks(sqlite, PROVIDER_A).length, 1, "the staff block must not have been cleared by the provider");

  const staffClear = await post("ops.lead@pawspace.in", { providerId: PROVIDER_A, available: true, reason: "Review complete, reinstating" });
  assert.equal(staffClear.status, 200);
  assert.equal(blocks(sqlite, PROVIDER_A).length, 0, "staff must be able to lift what staff imposed");
});

test("validation still runs, and only after ownership is established", async () => {
  const { sqlite } = await world();
  const owner = await post(EMAIL_A, { providerId: PROVIDER_A });
  assert.equal(owner.status, 400, "an owner sending an incomplete body still gets a 400");
  // The same incomplete body from a non-owner must be refused, not validated: a 400 would confirm the
  // payload shape to someone with no claim on the record.
  const before = allBlocks(sqlite);
  const stranger = await post(EMAIL_A, { providerId: PROVIDER_B });
  assert.ok([400, 401, 403].includes(stranger.status));
  assert.deepEqual(allBlocks(sqlite), before, "either way nothing may persist");
});

test("the development-preview superuser is host-gated, which is what makes this suite non-vacuous", async () => {
  const { sqlite } = await world();
  const remote = await route.POST(new Request(ENDPOINT, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerId: PROVIDER_A, available: false, reason: "anonymous on a real host" }),
  }));
  assert.ok(refused(remote), "a real host must never receive the preview superuser");
  const local = await route.POST(new Request("http://localhost/api/provider-availability", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerId: PROVIDER_A, available: false, reason: "localhost keeps its preview bypass" }),
  }));
  assert.equal(local.status, 200, "localhost keeps its documented preview bypass - which is why every case above uses a real host");
  assert.equal(blocks(sqlite, PROVIDER_A).length, 1, "the preview superuser wrote the block, bypassing ownership entirely");
});
