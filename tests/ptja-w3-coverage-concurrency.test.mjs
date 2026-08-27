/**
 * Optimistic concurrency on city coverage saves. [PTJA-W3-CC, closing PTJA-P1-F40]
 *
 * THE APPROVED RULE, supplied by the business:
 *   If Operator B saves after Operator A has changed the same coverage version - reject B's stale write
 *   with 409 Conflict, return the latest version, tell B the coverage changed and must be reloaded, and
 *   audit the conflict. No silent last-write-wins: coverage affects booking eligibility and provider
 *   supply, so silently overwriting it is unsafe.
 *
 * WHAT WAS MEASURED BEFORE. F40 was closed PARTIALLY. The version bump moved into SQL so concurrent
 * saves became monotonic, and RETURNING replaced a second SELECT so each operator was handed the row
 * their own statement wrote rather than the other operator's. What was explicitly left open, because it
 * needed a product decision and an API contract change, is the LOST UPDATE itself: operator A's
 * coverage was still silently replaced by operator B's. B loads the city, A saves a pincode removal, B
 * saves the list they loaded before A's change, and A's removal is gone with nobody told.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_CC_DB__", "__PTJA_CC_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  let depth = 0;
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      const outer = depth === 0;
      if (outer) sqlite.exec("BEGIN IMMEDIATE");
      depth += 1;
      try { const out = []; for (const item of items) out.push(await item.run()); if (outer) sqlite.exec("COMMIT"); return out; }
      catch (error) { if (outer) sqlite.exec("ROLLBACK"); throw error; }
      finally { depth -= 1; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const attempt = (promise) => promise.then(
  (value) => ({ ok: true, value }),
  async (error) => ({ ok: false, status: error instanceof Response ? error.status : 0, body: error instanceof Response ? await error.clone().json().catch(() => null) : null, message: error instanceof Response ? await error.clone().text() : String(error?.message ?? error) }),
);

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_CC_DB__ = db;
  globalThis.__PTJA_CC_ENV__ = {};
  const city = await import("../lib/city-governance.ts");
  await city.seedDefaultCityLaunchConfigs(db);
  const configs = await city.listCityLaunchConfigs(db);
  const bengaluru = configs.find((entry) => entry.cityCode === "blr") ?? configs[0];
  return { sqlite, db, city, bengaluru };
}

const inputFrom = (config, changes = {}) => ({
  id: config.id, cityCode: config.cityCode, city: config.city, state: config.state,
  status: config.status, centre: config.centre, radiusKm: config.radiusKm,
  pincodes: config.pincodes, gstIncluded: config.gstIncluded, services: config.services,
  ...changes,
});

test("CC-01: a save that does not say which version it read is refused", async () => {
  // The contract half. Without the base version the server cannot tell a fresh edit from a stale one,
  // and "I did not say" must not mean "overwrite whatever is there".
  const { db, city, bengaluru } = await world();
  const refused = await attempt(city.saveCityLaunchConfig(db, inputFrom(bengaluru, { pincodes: "560001,560002" }), "a@pawspace.test"));
  assert.equal(refused.ok, false, `an update must declare its base version: ${JSON.stringify(refused).slice(0, 300)}`);
  // The STATUS and CODE matter, not just the refusal. Written first asserting only `ok === false`, which
  // sabotage showed was shadowed: with the check deleted an absent version reads as NaN, fails the
  // staleness comparison and comes back as a 409. Both refuse, but "you did not say which version you
  // read" and "the version you read has moved" are different things to tell an operator, and only one
  // of them is fixed by reloading.
  assert.equal(refused.status, 400, `and be told it is a missing declaration, not a conflict: ${JSON.stringify(refused).slice(0, 300)}`);
  assert.equal(refused.body?.code, "base_version_required", `naming what is missing: ${JSON.stringify(refused.body).slice(0, 250)}`);
});

test("CC-02: a save that declares the version it read succeeds and bumps it", async () => {
  // Non-vacuity for CC-01 and CC-03. Refusing every save would satisfy both and freeze coverage.
  const { db, city, bengaluru } = await world();
  const saved = await attempt(city.saveCityLaunchConfig(db, inputFrom(bengaluru, { pincodes: "560001,560002", baseVersion: bengaluru.version }), "a@pawspace.test"));
  assert.equal(saved.ok, true, `a current save must succeed: ${JSON.stringify(saved).slice(0, 300)}`);
  assert.equal(saved.value.version, bengaluru.version + 1, "and the version moves forward");
  assert.equal(saved.value.pincodes, "560001,560002", "with the operator's own coverage");
});

test("CC-03: a stale save is refused with 409 Conflict", async () => {
  const { db, city, bengaluru } = await world();
  const bLoaded = bengaluru.version;
  await city.saveCityLaunchConfig(db, inputFrom(bengaluru, { pincodes: "560001", baseVersion: bengaluru.version }), "a@pawspace.test");
  const stale = await attempt(city.saveCityLaunchConfig(db, inputFrom(bengaluru, { pincodes: "560001,560002,560003", baseVersion: bLoaded }), "b@pawspace.test"));
  assert.equal(stale.ok, false, `B's stale write must be rejected: ${JSON.stringify(stale).slice(0, 300)}`);
  assert.equal(stale.status, 409, `with 409 Conflict: ${JSON.stringify(stale).slice(0, 300)}`);
});

test("CC-04: the conflict returns the latest version and tells the operator to reload", async () => {
  const { db, city, bengaluru } = await world();
  const bLoaded = bengaluru.version;
  await city.saveCityLaunchConfig(db, inputFrom(bengaluru, { pincodes: "560001", baseVersion: bengaluru.version }), "a@pawspace.test");
  const stale = await attempt(city.saveCityLaunchConfig(db, inputFrom(bengaluru, { pincodes: "560001,560002,560003", baseVersion: bLoaded }), "b@pawspace.test"));
  assert.equal(stale.body?.latestVersion, bLoaded + 1, `the latest version is returned: ${JSON.stringify(stale.body).slice(0, 300)}`);
  assert.equal(stale.body?.yourVersion, bLoaded, "alongside the one B was working from");
  assert.equal(stale.body?.latest?.pincodes, "560001", "and the coverage that is actually stored, so B can see what changed");
  assert.match(String(stale.body?.error ?? ""), /reload/i, `and B is told to reload: ${JSON.stringify(stale.body).slice(0, 300)}`);
});

test("CC-05: operator A's coverage survives operator B's stale save", async () => {
  // The lost update itself - the half F40 left open.
  const { sqlite, db, city, bengaluru } = await world();
  const bLoaded = bengaluru.version;
  await city.saveCityLaunchConfig(db, inputFrom(bengaluru, { pincodes: "560001", baseVersion: bengaluru.version }), "a@pawspace.test");
  await attempt(city.saveCityLaunchConfig(db, inputFrom(bengaluru, { pincodes: "560001,560002,560003", baseVersion: bLoaded }), "b@pawspace.test"));
  const stored = sqlite.prepare("SELECT pincodes,version FROM city_launch_configs WHERE id=?").get(bengaluru.id);
  assert.equal(String(stored.pincodes), "560001",
    "A's removal must still be in force; B's stale list must not have silently restored it");
  assert.equal(Number(stored.version), bLoaded + 1, "and the version reflects one accepted save, not two");
});

test("CC-06: the conflict is audited", async () => {
  const { sqlite, db, city, bengaluru } = await world();
  const bLoaded = bengaluru.version;
  await city.saveCityLaunchConfig(db, inputFrom(bengaluru, { pincodes: "560001", baseVersion: bengaluru.version }), "a@pawspace.test");
  await attempt(city.saveCityLaunchConfig(db, inputFrom(bengaluru, { pincodes: "560001,560002,560003", baseVersion: bLoaded }), "b@pawspace.test"));
  const conflict = sqlite.prepare("SELECT action,actor_id,before_json,after_json FROM city_launch_config_audit WHERE action LIKE '%conflict%'").get();
  assert.ok(conflict, "a rejected save is a thing that happened and must be recorded");
  assert.equal(String(conflict.actor_id), "b@pawspace.test", "naming who tried");
  assert.match(String(conflict.after_json), /560002/, `and what they tried to write: ${String(conflict?.after_json).slice(0, 250)}`);
});

test("CC-07: B can reload and save successfully on the new version", async () => {
  // The recovery path. A conflict that cannot be resolved is a broken screen, not a safety control.
  const { db, city, bengaluru } = await world();
  await city.saveCityLaunchConfig(db, inputFrom(bengaluru, { pincodes: "560001", baseVersion: bengaluru.version }), "a@pawspace.test");
  const reloaded = (await city.listCityLaunchConfigs(db)).find((entry) => entry.id === bengaluru.id);
  const saved = await attempt(city.saveCityLaunchConfig(db, inputFrom(reloaded, { pincodes: "560001,560002", baseVersion: reloaded.version }), "b@pawspace.test"));
  assert.equal(saved.ok, true, `B's save on the reloaded version must succeed: ${JSON.stringify(saved).slice(0, 300)}`);
  assert.equal(saved.value.pincodes, "560001,560002", "with B's coverage");
});

test("CC-08: creating a NEW city needs no base version", async () => {
  // There is nothing to be stale against. Requiring a base version on create would block every new city.
  const { db, city, bengaluru } = await world();
  const created = await attempt(city.saveCityLaunchConfig(db, {
    cityCode: "del", city: "Delhi", state: "Delhi", status: "Draft", centre: "28.61,77.20",
    radiusKm: 20, pincodes: "110001", gstIncluded: true, services: JSON.parse(JSON.stringify(bengaluru.services)),
  }, "a@pawspace.test"));
  assert.equal(created.ok, true, `a new city is created without one: ${JSON.stringify(created).slice(0, 300)}`);
  assert.equal(created.value.version, 1, "starting at version 1");
});

test("CC-09: two saves both claiming the same base version - only one is accepted", async () => {
  const { sqlite, db, city, bengaluru } = await world();
  const base = bengaluru.version;
  const results = await Promise.all([
    attempt(city.saveCityLaunchConfig(db, inputFrom(bengaluru, { pincodes: "560001", baseVersion: base }), "a@pawspace.test")),
    attempt(city.saveCityLaunchConfig(db, inputFrom(bengaluru, { pincodes: "560099", baseVersion: base }), "b@pawspace.test")),
  ]);
  const accepted = results.filter((entry) => entry.ok);
  assert.equal(accepted.length, 1, `exactly one save may win: ${JSON.stringify(results).slice(0, 400)}`);
  const stored = sqlite.prepare("SELECT pincodes,version FROM city_launch_configs WHERE id=?").get(bengaluru.id);
  assert.equal(Number(stored.version), base + 1, "and the version advances once, not twice");
  assert.equal(String(stored.pincodes), accepted[0].value.pincodes, "and the stored coverage is the winner's own");
});

test("CC-10: the route answers 409 rather than redacting the conflict", async () => {
  const { sqlite, db, city, bengaluru } = await world();
  const auth = await import("../lib/server-auth.ts");
  await auth.ensureSecurityTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('u-b','b@pawspace.test','B','founder','active',?,?)").run(now, now);
  const bLoaded = bengaluru.version;
  await city.saveCityLaunchConfig(db, inputFrom(bengaluru, { pincodes: "560001", baseVersion: bengaluru.version }), "a@pawspace.test");
  const route = await import("../app/api/city-governance/route.ts");
  const response = await route.POST(new Request("https://uat.pawspace.in/api/city-governance", {
    method: "POST",
    headers: { "content-type": "application/json", "oai-authenticated-user-email": "b@pawspace.test", "oai-authenticated-user-full-name": "B" },
    body: JSON.stringify({ action: "save_city", city: inputFrom(bengaluru, { pincodes: "560001,560002,560003", baseVersion: bLoaded }) }),
  }));
  const body = await response.json().catch(() => null);
  assert.equal(response.status, 409, `the operator must be told it is a conflict: ${JSON.stringify(body).slice(0, 300)}`);
  assert.match(String(body?.error ?? ""), /reload/i, `and what to do about it: ${JSON.stringify(body).slice(0, 300)}`);
});
