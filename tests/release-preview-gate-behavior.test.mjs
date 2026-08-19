import test from "node:test";
import assert from "node:assert/strict";
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGate, boundedAll, assertRunTag, TOUCHED_TABLES, SUPPORT_TABLES, REQUIRED_TABLES, AUTHORITATIVE_DDL_SOURCES, PROVIDER_ACTIVATION_VARS, extractDdl, extractAllDdl, ddlFromCheckout, requiredColumnsOf, roleDefinitionInsert } from "./e2e/release-preview-gate.mjs";

/**
 * The repository itself stands in for the candidate checkout, and the DDL the mock world enforces is the
 * REAL product DDL, extracted by the same function the CLI uses. A fixture schema written here would turn
 * every "required column" assertion below into a test of the fixture.
 */
const CANDIDATE_ROOT = new URL("..", import.meta.url).pathname;
const realDdl = async (table) => ddlFromCheckout(CANDIDATE_ROOT, table);

// ---------------------------------------------------------------------------
// The hosted gate is the only thing that will look at the release candidate running on real Workers
// and real D1. If it passes something it should have caught, nothing downstream is looking.
//
// Its first version shipped four defects that reading did not catch, and every one of them PASSED:
//
//   the replay snapshot was taken before an earlier booking, so the comparison folded that booking in
//     and a replay that wrote a row could still balance out;
//   the shared-staging database was never compared, so a preview pointed at staging read as isolated;
//   the twelve-booking convergence test counted distinct ids without requiring twelve successes, so
//     eleven failures and one success looked like perfect convergence;
//   the swarm ran in a sequential loop, so "concurrency" proved nothing about concurrency.
//
// A gate that cannot be tested cannot be trusted, so runGate takes its HTTP and D1 access as adapters.
// Each test below drives it against a mock world, and each sabotage test re-introduces one of those
// defects and asserts the gate now FAILS — which is the only evidence that the fix is load-bearing.
// ---------------------------------------------------------------------------

/**
 * A mock world: an in-memory row store behind a tiny SQL subset, and an HTTP surface that behaves the
 * way the real route does for the cases the gate exercises. Faults are injectable per scenario.
 */
const ACCESS_CODE = "x".repeat(32);

function makeWorld(faults = {}) {
  // THE DATABASE STARTS EMPTY, because a freshly created preview D1 is empty and this candidate ships no
  // migrations. Nothing is pre-created and every access goes through `rows()`, which throws "no such
  // table" exactly as D1 does — so a gate that reads or writes before creating cannot pass here either.
  //
  // The booking tables are NOT pre-created on the theory that "the route makes them on first request".
  // The gate's first snapshot runs before any request reaches the route, and the mock route does not
  // model ensureTables on purpose: the bootstrap must be the single guarantee, not a fallback behind
  // product DDL, or a table dropped from it would go unnoticed.
  //
  // NOTHING is pre-created — not even `providers`, which was the last exception. That exception modelled
  // "a preview in which a provider route has already run", and no such preview can exist: this product
  // has no `providers` table for any route to create, and two of the three columns that check filtered on
  // appear in no source file at all. Pre-creating it meant the one read that could never succeed was the
  // one the mock always answered. The gate now proves provider activation from deployed configuration
  // instead, and this mock starts as empty as a freshly created D1 really is.
  //
  // `required` comes from the REAL extracted DDL, so an INSERT missing a NOT NULL column fails here
  // exactly as it fails on real D1.
  const tables = {};
  const required = {};
  const sqlLog = [];
  const sessions = new Map();
  const httpLog = [];
  let inFlight = 0, maxInFlight = 0;

  const rows = (name) => {
    if (!(name in tables)) throw new Error(`no such table: ${name}`);
    return tables[name];
  };

  const permissionsFor = (email) => {
    const user = rows("app_users").find((u) => u.email === email);
    const role = rows("role_definitions").find((r) => r.code === user?.role_code);
    return role ? JSON.parse(role.permissions_json) : [];
  };

  const d1 = async (sql) => {
    const create = sql.match(/^CREATE TABLE IF NOT EXISTS (\w+) \(/);
    if (create) {
      sqlLog.push({ kind: "CREATE", table: create[1] });
      required[create[1]] = requiredColumnsOf(sql);
      tables[create[1]] = tables[create[1]] || [];
      return [];
    }
    sqlLog.push({ kind: /^INSERT/i.test(sql) ? "INSERT" : "SELECT", sql });
    const insert = sql.match(/^INSERT OR REPLACE INTO (\w+) \(([^)]*)\) VALUES \((.*)\)$/s);
    if (insert) {
      const [, table, cols, vals] = insert;
      const keys = cols.split(",").map((c) => c.trim());
      const values = vals.match(/'(?:[^']|'')*'|[^,]+/g).map((v) => v.trim().replace(/^'|'$/g, "").replace(/''/g, "'"));
      const row = Object.fromEntries(keys.map((k, i) => [k, values[i]]));
      // Real database behaviour, and the reason the gate must create these tables before it seeds them.
      const store = rows(table);
      for (const column of required[table] ?? []) {
        if (!(column in row)) throw new Error(`NOT NULL constraint failed: ${table}.${column}`);
      }
      const pk = keys[0];
      const existing = store.findIndex((r) => r[pk] === row[pk]);
      if (existing >= 0) store[existing] = row; else store.push(row);
      return [];
    }
    const count = sql.match(/^SELECT COUNT\(\*\) n FROM (\w+)(?: WHERE (.*))?$/s);
    if (count) {
      const [, table, where] = count;
      const store = rows(table);
      if (!where || where === "1=1") return [{ n: store.length }];
      const like = where.match(/schedule_group_id LIKE '([^']*)%'/);
      if (like) return [{ n: store.filter((r) => String(r.schedule_group_id || "").startsWith(like[1])).length }];
      const eq = where.match(/customer_id='([^']*)' AND source_pet_id='([^']*)'/);
      if (eq) return [{ n: store.filter((r) => r.customer_id === eq[1] && r.source_pet_id === eq[2]).length }];
      return [{ n: store.length }];
    }
    if (/LEFT JOIN canonical_bookings/.test(sql)) { rows(sql.match(/FROM (\w+)/)[1]); rows("canonical_bookings"); return [{ n: 0 }]; }
    if (/JOIN canonical_bookings/.test(sql)) {
      const table = sql.match(/FROM (\w+)/)[1];
      const like = sql.match(/LIKE '([^']*)%'/);
      const bookingIds = new Set(rows("canonical_bookings")
        .filter((b) => !like || String(b.schedule_group_id).startsWith(like[1])).map((b) => b.id));
      return [{ n: rows(table).filter((r) => bookingIds.has(r.booking_id)).length }];
    }
    if (/GROUP BY source_pet_id HAVING COUNT\(\*\)>1/.test(sql)) {
      // Scoped by customer_id, exactly as the gate's SQL is. Two runs share source ids like "swarm-0"
      // under DIFFERENT customers; ignoring the filter would call that a duplicate when it is not.
      const owner = sql.match(/customer_id='([^']*)'/)?.[1];
      const seen = {};
      for (const p of rows("canonical_pets")) {
        if (owner && p.customer_id !== owner) continue;
        if (String(p.source_pet_id).startsWith("swarm-")) seen[p.source_pet_id] = (seen[p.source_pet_id] || 0) + 1;
      }
      return [{ n: Object.values(seen).filter((n) => n > 1).length }];
    }
    const select = sql.match(/^SELECT ([\w,]+) FROM (\w+) WHERE id='([^']*)'$/);
    if (select) {
      const row = rows(select[2]).find((r) => r.id === select[3]);
      return row ? [row] : [];
    }
    return [];
  };

  const rawHttp = async (method, path, { headers = {}, body } = {}) => {
      httpLog.push({ method, path });
      if (path === "/api/staging-login") {
        // The real route reads body.code and returns 401 "Invalid access code" otherwise. It does NOT
        // look at accessCode, so neither does this: a mock that accepted both would have let the
        // original wrong-field bug through exactly as it did.
        if (body?.code !== ACCESS_CODE) return { status: 401, body: { error: "Invalid access code" }, headers: {} };
        const email = body?.email;
        // ...and the email must be an active staff record whose role has a definition.
        const user = rows("app_users").find((u) => u.email === email && u.status === "active");
        const role = user && rows("role_definitions").find((r) => r.code === user.role_code);
        if (!user || !role) return { status: 403, body: { error: "That email cannot sign in here" }, headers: {} };
        const cookie = `ps=${email}`;
        sessions.set(cookie, email);
        return { status: 200, body: { ok: true }, headers: { "set-cookie": `${cookie}; Path=/` } };
      }
      const email = sessions.get(String(headers.cookie || ""));
      const perms = email ? permissionsFor(email)
        : (faults.allowAnonymous ? ["bookings.view", "scheduling.book"] : []);
      if (method === "GET") {
        if (!perms.includes("bookings.view")) return { status: 403, body: { error: "denied" }, headers: {} };
        return {
          status: 200, headers: {},
          body: { bookings: rows("canonical_bookings").map((b) => ({ ...b, pets: rows("canonical_pets").filter((p) => JSON.parse(b.pet_ids_json).includes(p.id)) })) },
        };
      }
      if (!perms.includes("scheduling.book")) return { status: 403, body: { error: "denied" }, headers: {} };

      // Ownership before the replay lookup, as requireCustomerOwnership runs before it in the route.
      const link = rows("customer_identity_links").find((l) => l.email === email);
      if (!faults.ownershipBypass && link && link.customer_id !== body.customer.id) {
        return { status: 403, body: { error: "Customer ownership denied" }, headers: {} };
      }

      const prior = rows("canonical_bookings").find((b) => b.idempotency_key === body.idempotencyKey || b.schedule_group_id === body.scheduleGroupId);
      if (prior) return { status: 200, body: { data: { bookingId: prior.id, duplicatePrevented: true, petIds: JSON.parse(prior.pet_ids_json) } }, headers: {} };

      for (const pet of body.pets) if (typeof pet.sourceId !== "string") return { status: 400, body: { error: "A pet source id must be text" }, headers: {} };
      const reservation = rows("scheduling_reservations").find((r) => r.group_id === body.scheduleGroupId);
      if (!reservation) return { status: 409, body: { error: "Scheduling must be assigned" }, headers: {} };
      if (reservation.city_id !== body.cityId || reservation.zone_id !== body.zoneId) {
        return { status: 409, body: { error: "The booking city/zone does not match" }, headers: {} };
      }

      const petIds = body.pets.map((pet) => {
        const existing = faults.duplicatePets ? null : rows("canonical_pets").find((p) => p.customer_id === body.customer.id && p.source_pet_id === pet.sourceId);
        if (existing) return existing.id;
        const id = faults.duplicatePets ? `PET-${body.customer.id}-${pet.sourceId}-${rows("canonical_pets").length}` : `PET-${body.customer.id}-${pet.sourceId}`;
        rows("canonical_pets").push({ id, customer_id: body.customer.id, name: pet.name, species: pet.species || "dog", breed: pet.breed ?? null, vaccination_status: "not_provided", source_pet_id: String(pet.sourceId) });
        return id;
      });
      const id = `BK-${rows("canonical_bookings").length}`;
      rows("canonical_bookings").push({ id, idempotency_key: body.idempotencyKey, schedule_group_id: body.scheduleGroupId, customer_id: body.customer.id, pet_ids_json: JSON.stringify(petIds) });
      rows("booking_payments").push({ id: `PAY-${id}`, booking_id: id });
      rows("provider_work_orders").push({ id: `WO-${id}`, booking_id: id });
      rows("booking_lifecycle_events").push({ id: `EV-${id}`, booking_id: id });
      return { status: 201, body: { data: { bookingId: id, petIds, duplicatePrevented: false } }, headers: {} };
  };

  /** The real timing/leak wrapper: concurrency accounting, and the injectable refusal-write fault. */
  const http = async (method, path, opts = {}) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, 1));
      const res = await rawHttp(method, path, opts);
      // A route that writes on a path it then refuses — the defect the zero-write snapshots exist for.
      if (faults.writeOnRefusal && method === "POST" && path === "/api/canonical-bookings" && res.status >= 400) {
        rows("booking_lifecycle_events").push({ id: `leak-${rows("booking_lifecycle_events").length}`, booking_id: "none" });
      }
      return res;
    } finally { inFlight--; }
  };

  return { http, d1, tables, required, rows, sqlLog, httpLog, stats: () => ({ maxInFlight }) };
}

const ENV = { EXPECTED_SHA: "b52e7dc1c04efa36d7e89e1b06ad252f9cf5ab6e", ACCESS_CODE, RUN_TAG: "9001-1" };
const silent = () => {};
/** What a correct world supplies for the three mandatory-evidence adapters. */
const okHostedSha = async () => `{"annotations":{"workers/tag":"${ENV.EXPECTED_SHA}"}}`;
const okWorkerLog = async () => '{"outcome":"ok","status":200}';
/** A deployed configuration with activation off — what the preview config script writes. */
const okProviderActivation = async () => ({ ...PROVIDER_ACTIVATION_VARS });
const run = (world, over = {}) => runGate({
  http: world.http, d1: world.d1, ddl: realDdl, hostedSha: okHostedSha, workerLog: okWorkerLog,
  providerActivation: okProviderActivation, env: ENV, log: silent, swarmSize: 6, concurrency: 3, ...over,
});
const failed = (report, needle) => report.checks.filter((c) => !c.ok && c.name.includes(needle));

// --- the gate passes against a correct world ---------------------------------------------------

test("against a correct world the gate passes every check", async () => {
  const report = await run(makeWorld());
  assert.equal(report.failures, 0, `failing checks: ${report.checks.filter((c) => !c.ok).map((c) => c.name).join("; ")}`);
  assert.ok(report.checks.length >= 25, `expected a substantial gate, saw ${report.checks.length} checks`);
});

test("the gate proves authorization with real sessions, and stops if it cannot get them", async () => {
  const world = makeWorld();
  // No session can be established: sign-in refuses every identity.
  const brokenSignIn = { ...world, http: async (m, p, o) => (p === "/api/staging-login" ? { status: 403, body: null, headers: {} } : world.http(m, p, o)) };
  const report = await run(brokenSignIn);
  assert.equal(report.authHarness, "unavailable", "a gate without real sessions must say so rather than report refusals");
  assert.ok(failed(report, "real UAT sessions").length === 1);
  // And it must not go on to claim authorization results it never obtained.
  assert.ok(!report.checks.some((c) => c.name.includes("GET succeeds with bookings.view")));
});

test("authorization is proved through the session layer, not through client headers", async () => {
  const world = makeWorld();
  await run(world);
  assert.ok(world.httpLog.some((r) => r.path === "/api/staging-login"), "the gate must sign in through the real endpoint");
  const roles = world.tables.role_definitions.map((r) => r.code).sort();
  assert.deepEqual(roles, ["preview_booker", "preview_marketing", "preview_viewer"],
    "three distinct roles must be seeded so permission differences are real, not asserted");
});

// --- sabotage: each historical defect must now fail --------------------------------------------

test("SABOTAGE — a write during a refused request is caught", async () => {
  const report = await run(makeWorld({ writeOnRefusal: true }));
  assert.notEqual(report.failures, 0, "a refusal that writes must fail the gate");
  assert.ok(failed(report, "zero writes").length > 0 || failed(report, "wrote nothing").length > 0,
    `expected a zero-write failure, got: ${report.checks.filter((c) => !c.ok).map((c) => c.name).join("; ")}`);
});

test("SABOTAGE — a replay that writes a row is caught, whatever happened earlier", async () => {
  // The old defect: the snapshot was taken before an earlier successful booking, so a replay that
  // wrote a row could still balance. Here the replay itself writes, and nothing else changes.
  const world = makeWorld();
  const original = world.http;
  let replaySeen = 0;
  const leaky = {
    ...world,
    http: async (method, path, opts) => {
      const res = await original(method, path, opts);
      if (res.status === 200 && res.body?.data?.duplicatePrevented && ++replaySeen === 1) {
        world.tables.booking_lifecycle_events.push({ id: "replay-leak", booking_id: "none" });
      }
      return res;
    },
  };
  const report = await run(leaky);
  assert.ok(failed(report, "changed nothing").length > 0,
    `a replay side effect must be caught: ${report.checks.filter((c) => !c.ok).map((c) => c.name).join("; ")}`);
});

test("SABOTAGE — eleven failures and one success is not convergence", async () => {
  const world = makeWorld();
  const original = world.http;
  let sevenSeen = 0;
  const flaky = {
    ...world,
    http: async (method, path, opts) => {
      // Only the FIRST string-"7" booking succeeds; the rest 500. The distinct-id count would still
      // be 1, which is exactly how the old test passed.
      if (method === "POST" && opts?.body?.pets?.[0]?.sourceId === "7" && ++sevenSeen > 1) {
        return { status: 500, body: { error: "boom" }, headers: {} };
      }
      return original(method, path, opts);
    },
  };
  const report = await run(flaky);
  assert.ok(failed(report, "all 12 string").length === 1, "every one of the twelve must be required to succeed");
});

test("SABOTAGE — a sequential loop cannot pass as the concurrency swarm", async () => {
  // boundedAll is what makes the swarm concurrent. Driving it at a limit of 1 is precisely the old
  // sequential loop, and the gate must notice.
  const report = await run(makeWorld(), { concurrency: 1 });
  assert.ok(failed(report, "really ran concurrently").length === 1, "a max-in-flight of 1 must fail");
  assert.equal(report.counts.maxInFlight, 1);
});

test("SABOTAGE — duplicate canonical pets in the swarm are caught", async () => {
  const report = await run(makeWorld({ duplicatePets: true }));
  assert.ok(failed(report, "duplicate canonical pets").length === 1 || failed(report, "converged on exactly one").length === 1,
    `expected a duplicate-pet failure: ${report.checks.filter((c) => !c.ok).map((c) => c.name).join("; ")}`);
});

test("SABOTAGE — a 5xx anywhere in the swarm fails the gate", async () => {
  const world = makeWorld();
  const original = world.http;
  const broken = {
    ...world,
    http: async (method, path, opts) => (String(opts?.body?.scheduleGroupId || "").includes("-swarm-3")
      ? { status: 503, body: null, headers: {} }
      : original(method, path, opts)),
  };
  const report = await run(broken);
  assert.ok(failed(report, "no unexpected 5xx").length === 1);
});

test("SABOTAGE — a numeric source id that blocks historical replay is caught", async () => {
  const world = makeWorld();
  const original = world.http;
  const strict = {
    ...world,
    http: async (method, path, opts) => {
      // Validation placed BEFORE the idempotency lookup: the exact regression this asserts against.
      if (method === "POST" && opts?.body?.pets?.some((p) => typeof p.sourceId !== "string")) {
        return { status: 400, body: { error: "A pet source id must be text" }, headers: {} };
      }
      return original(method, path, opts);
    },
  };
  const report = await run(strict);
  assert.ok(failed(report, "does not block historical replay").length === 1);
});

test("SABOTAGE — losing the saved Bruno row is caught", async () => {
  const world = makeWorld();
  const original = world.http;
  const clobber = {
    ...world,
    http: async (method, path, opts) => {
      const res = await original(method, path, opts);
      if (opts?.body?.pets?.[0]?.sourceId === "acct-bruno" && res.status === 201) {
        const pet = world.tables.canonical_pets.find((p) => p.source_pet_id === "acct-bruno");
        if (pet) { pet.breed = null; pet.vaccination_status = "not_provided"; }
      }
      return res;
    },
  };
  const report = await run(clobber);
  assert.ok(failed(report, "breed and verification status are unchanged").length === 1);
});

// --- the login contract, the anonymous cases, ownership, and repeatability ----------------------

test("sign-in uses the route's real field: body.code, never body.accessCode", async () => {
  const world = makeWorld();
  const seen = [];
  const observed = { ...world, http: async (m, p, o) => { if (p === "/api/staging-login") seen.push(o?.body); return world.http(m, p, o); } };
  const report = await run(observed);
  assert.equal(report.failures, 0);
  assert.ok(seen.length >= 3, "the gate must sign in for each role");
  for (const body of seen) {
    assert.equal(body.code, ACCESS_CODE, "the access code must be sent as `code`");
    assert.equal(body.accessCode, undefined, "`accessCode` is not a field this route reads");
    assert.ok(body.email, "an email must be supplied");
  }
});

test("SABOTAGE — sending accessCode instead of code fails the auth harness", async () => {
  // The exact defect: the previous gate sent { accessCode }, which the route ignores, so every
  // sign-in would have returned 401 and the whole authorization section would have been meaningless.
  const world = makeWorld();
  const wrongField = {
    ...world,
    http: async (method, path, opts) => {
      if (path === "/api/staging-login") {
        const { code, ...rest } = opts.body;          // re-introduce the bug: rename code -> accessCode
        return world.http(method, path, { ...opts, body: { ...rest, accessCode: code } });
      }
      return world.http(method, path, opts);
    },
  };
  const report = await run(wrongField);
  assert.equal(report.authHarness, "unavailable", "the gate must halt rather than report unearned refusals");
  assert.ok(failed(report, "real UAT sessions").length === 1);
});

test("anonymous requests are checked before any session exists, and write nothing", async () => {
  const world = makeWorld();
  const order = [];
  const traced = { ...world, http: async (m, p, o) => { order.push(`${m} ${p}${o?.headers?.cookie ? " +cookie" : ""}`); return world.http(m, p, o); } };
  const report = await run(traced);
  assert.equal(report.failures, 0);
  const firstLogin = order.findIndex((e) => e.includes("/api/staging-login"));
  const firstAnonBooking = order.findIndex((e) => e.includes("/api/canonical-bookings") && !e.includes("+cookie"));
  assert.ok(firstAnonBooking >= 0, "there must be requests that carry no cookie at all");
  assert.ok(firstLogin >= 0, "the gate must sign in at some point");
  assert.ok(firstAnonBooking < firstLogin, "the anonymous cases must run BEFORE any session exists");
  for (const name of ["anonymous GET is refused", "an anonymous GET discloses no bookings", "anonymous POST is refused", "an anonymous POST changed nothing"]) {
    assert.ok(report.checks.some((c) => c.name.includes(name) && c.ok), `missing or failing: ${name}`);
  }
});

test("SABOTAGE — an anonymous POST that is accepted is caught", async () => {
  // allowAnonymous makes the route treat a cookieless caller as fully permitted — which is the shape
  // of the defect an anonymous test exists to catch.
  const report = await run(makeWorld({ allowAnonymous: true }));
  assert.ok(failed(report, "anonymous").length > 0, "an accepted anonymous request must fail the gate");
});

test("SABOTAGE — bypassing ownership makes the wrong-owner request reach 201, proving the case is not vacuous", async () => {
  // The point of the sabotage: with ownership removed the SAME request succeeds. That can only happen
  // if the scheduling decision and reservation for the other customer really were seeded — so the 403
  // in the healthy run is the ownership layer and not a 409 for a missing precondition.
  const world = makeWorld({ ownershipBypass: true });
  const statuses = [];
  const observed = {
    ...world,
    http: async (m, p, o) => {
      const res = await world.http(m, p, o);
      if (String(o?.body?.scheduleGroupId || "").endsWith("-owner")) statuses.push(res.status);
      return res;
    },
  };
  const report = await run(observed);
  assert.ok(statuses.includes(201), `the wrong-owner request must be able to reach 201, saw ${statuses.join(",")}`);
  assert.ok(failed(report, "exactly 403").length === 1, "and the gate must fail when it does");
});

test("two runs with different tags both execute as new tests against one database", async () => {
  const world = makeWorld();
  const first = await run(world, { env: { ...ENV, RUN_TAG: "9001-1" }, swarmSize: 4 });
  const second = await run(world, { env: { ...ENV, RUN_TAG: "9001-2" }, swarmSize: 4 });
  assert.equal(first.failures, 0, `first run: ${first.checks.filter((c) => !c.ok).map((c) => c.name).join("; ")}`);
  assert.equal(second.failures, 0, `second run: ${second.checks.filter((c) => !c.ok).map((c) => c.name).join("; ")}`);
  assert.equal(first.runTag, "9001-1");
  assert.equal(second.runTag, "9001-2");
  // The second run CREATED its own booking rather than replaying the first run's.
  const created = second.checks.find((c) => c.name.includes("POST succeeds with scheduling.book"));
  assert.ok(created?.ok, "the second run must reach a fresh 201, not a replay");
  // The tag itself contains a hyphen, so the namespaces are compared by their full RUN prefix rather
  // than by counting hyphen-separated segments.
  const prefixFor = (tag) => `preview-${ENV.EXPECTED_SHA.slice(0, 8)}-${tag}-`;
  for (const tag of ["9001-1", "9001-2"]) {
    const owned = world.tables.canonical_bookings.filter((b) => String(b.schedule_group_id).startsWith(prefixFor(tag)));
    assert.ok(owned.length > 0, `run ${tag} must own bookings in its own namespace`);
  }
  const crossed = world.tables.canonical_bookings.filter((b) =>
    String(b.schedule_group_id).startsWith(prefixFor("9001-1")) && String(b.schedule_group_id).startsWith(prefixFor("9001-2")));
  assert.equal(crossed.length, 0, "no booking may belong to both namespaces");
});

test("SABOTAGE — a constant run tag makes the second run replay the first", async () => {
  const world = makeWorld();
  const tag = "constant-gate";
  const first = await run(world, { env: { ...ENV, RUN_TAG: tag }, swarmSize: 4 });
  const second = await run(world, { env: { ...ENV, RUN_TAG: tag }, swarmSize: 4 });
  assert.equal(first.failures, 0, "the first run is healthy");
  assert.notEqual(second.failures, 0, "the second run must NOT quietly pass by replaying the first");
  const created = second.checks.find((c) => c.name.includes("POST succeeds with scheduling.book"));
  assert.equal(created?.ok, false, "the booking that should have been created returned a replay instead");
});

test("the run tag is validated before it can reach generated SQL, and is never defaulted", () => {
  for (const bad of ["", undefined, null, "a'; DROP TABLE canonical_bookings;--", "has space", "-leading", "x".repeat(65), "tag;rm"]) {
    assert.throws(() => assertRunTag(bad), /safe identifier/, `${JSON.stringify(bad)} must be refused`);
  }
  for (const good of ["9001-1", "abc_123", "A1", "x".repeat(64)]) assert.equal(assertRunTag(good), good);
  // And runGate itself refuses rather than inventing one.
  assert.rejects(() => runGate({ http: async () => ({ status: 200, body: {} }), d1: async () => [], env: { EXPECTED_SHA: ENV.EXPECTED_SHA, ACCESS_CODE }, log: silent }), /safe identifier/);
});

// --- the concurrency primitive itself ----------------------------------------------------------

test("boundedAll runs concurrently, respects its limit, and preserves order", async () => {
  const order = [];
  const tasks = Array.from({ length: 10 }, (_, i) => async () => {
    order.push(i);
    await new Promise((r) => setTimeout(r, 2));
    return i * 2;
  });
  const { results, maxInFlight } = await boundedAll(tasks, 4);
  assert.deepEqual(results, tasks.map((_, i) => i * 2), "results must stay in task order");
  assert.ok(maxInFlight > 1, `expected overlap, saw ${maxInFlight}`);
  assert.ok(maxInFlight <= 4, `the limit must hold, saw ${maxInFlight}`);
  assert.equal(order.length, 10, "every task must run");
});

test("boundedAll at a limit of one is sequential, and reports it honestly", async () => {
  const { maxInFlight } = await boundedAll(Array.from({ length: 5 }, () => async () => new Promise((r) => setTimeout(r, 1))), 1);
  assert.equal(maxInFlight, 1, "a limit of one must report a high-water mark of one, not a comfortable lie");
});

// --- the gate never leaks -----------------------------------------------------------------------

test("no credential, cookie or database id reaches the report", async () => {
  const world = makeWorld();
  const report = await run(world);
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes(ENV.ACCESS_CODE), "the access code must never be reported");
  assert.ok(!/ps=preview-/.test(serialized), "no session cookie may be reported");
  for (const key of ["PREVIEW_D1", "CLOUDFLARE_API_TOKEN"]) {
    assert.ok(!serialized.includes(key), `${key} must not appear in the report`);
  }
});

test("adapter failures are redacted before they reach evidence", async () => {
  const identifier = "12345678-1234-1234-1234-123456789abc";
  const report = await run(makeWorld(), {
    hostedSha: async () => { throw new Error(`command failed for ${identifier} using ${ENV.ACCESS_CODE}`); },
  });
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes(identifier), "an identifier embedded in a command failure must be redacted");
  assert.ok(!serialized.includes(ENV.ACCESS_CODE), "a credential embedded in a command failure must be redacted");
  assert.match(serialized, /<redacted-id>/, "the reason must remain legible without exposing the value");
});

test("the real adapters resolve the isolated D1 binding and deployed version detail", () => {
  const source = readFileSync(new URL("./e2e/release-preview-gate.mjs", import.meta.url), "utf8");
  assert.match(source, /"d1", "execute", "DB", "--config", path\.join\(CANDIDATE_DIR, "dist\/server\/wrangler\.json"\)/,
    "D1 execute must use the binding in the generated candidate config");
  assert.doesNotMatch(source, /"d1", "execute", PREVIEW_D1/,
    "wrangler d1 execute does not resolve a raw database identifier as its positional name");
  assert.match(source, /"versions", "view", versionId/,
    "deployed variables must be read from version detail, not version-list metadata");
  assert.match(source, /binding\.type === "plain_text"/,
    "only non-secret deployed bindings may be selected");
});

test("the CLI requires the account-qualified deployed URL and always writes sanitized failure evidence", () => {
  const source = readFileSync(new URL("./e2e/release-preview-gate.mjs", import.meta.url), "utf8");
  assert.match(source, /const PREVIEW_URL = process\.env\.PREVIEW_URL/);
  assert.match(source, /const BASE = PREVIEW_URL/);
  assert.doesNotMatch(source, /`https:\/\/\$\{WORKER\}\.workers\.dev`/,
    "a Worker name alone is not a resolvable workers.dev hostname");
  assert.match(source, /catch \(error\)[\s\S]*hosted gate completed[\s\S]*sanitizeEvidenceDetail/,
    "an unexpected hosted failure must still produce redacted evidence");
});

test("the gate snapshots all five booking tables, not a subset", () => {
  assert.deepEqual([...TOUCHED_TABLES].sort(), [
    "booking_lifecycle_events", "booking_payments", "canonical_bookings", "canonical_pets", "provider_work_orders",
  ], "a table left out of the snapshot is a table a refusal could write to unnoticed");
});

// ---------------------------------------------------------------------------
// CONSOLIDATION — the three controls the competing implementation (#204) had and this gate did not.
// A, C and D are this branch's own and are covered above; nothing here restates them.
// ---------------------------------------------------------------------------

// --- B. a freshly created preview database has no support tables -------------------------------

test("B — every support table is created from the candidate's own DDL, before anything is seeded", async () => {
  const world = makeWorld();
  const asked = [];
  const report = await run(world, { ddl: async (table) => { asked.push(table); return realDdl(table); } });
  // ALL TWELVE, not just the five the gate seeds. Six of the rest are the ones it READS: snapshot() runs
  // COUNT(*) over the five booking tables before any request has reached the route, and canonical_customers
  // exists only as a side effect of a booking the gate might never get to make. The twelfth,
  // canonical_providers, is neither seeded nor queried — it is bootstrapped because the deployed provider
  // module owns it and a preview missing its schema is not a whole preview.
  assert.deepEqual(asked, REQUIRED_TABLES, `all ${REQUIRED_TABLES.length}, in order, and before the first seed`);
  for (const table of REQUIRED_TABLES) {
    assert.ok(world.tables[table], `${table} must exist once the gate has created it`);
    assert.ok(world.required[table]?.length > 0, `${table}'s NOT NULL columns must come from the real DDL, not a fixture`);
  }
  assert.equal(report.failures, 0, report.checks.filter((c) => !c.ok).map((c) => c.name).join("; "));
});

test("B — SABOTAGE: with no schema step the gate stops on an empty database instead of reporting refusals", async () => {
  // Exactly the state of a newly created preview D1: the booking tables the product route owns exist,
  // the support tables do not. The old gate seeded straight into them and died on "no such table".
  const report = await run(makeWorld(), { ddl: async () => null });
  assert.equal(report.schema, "unavailable", "it must halt, not push on");
  assert.ok(report.failures >= REQUIRED_TABLES.length, `each missing table must count as a failure, saw ${report.failures}`);
  assert.ok(!report.checks.some((c) => c.name.includes("real UAT sessions")), "and it must not claim results it never obtained");
});

test("B — an empty database really does reject the seeds, which is why the step exists", async () => {
  const world = makeWorld();
  await assert.rejects(() => world.d1(roleDefinitionInsert("preview_viewer", ["bookings.view"])),
    /no such table: role_definitions/, "seeding a table nothing created must fail");
  await world.d1(await realDdl("role_definitions"));
  await world.d1(roleDefinitionInsert("preview_viewer", ["bookings.view"]));
  assert.equal(world.tables.role_definitions.length, 1, "and succeed once the DDL has been applied");
});

test("B — the role insert satisfies every NOT NULL column, and the two-column shape is rejected", async () => {
  const ddl = await realDdl("role_definitions");
  assert.ok(ddl, "the product must define role_definitions");
  // The real shape, read from the real DDL rather than restated here.
  assert.deepEqual(requiredColumnsOf(ddl).sort(), ["description", "name", "permissions_json", "updated_at"]);

  const world = makeWorld();
  await world.d1(ddl);
  await world.d1(roleDefinitionInsert("preview_viewer", ["bookings.view"]));
  assert.equal(world.tables.role_definitions.length, 1, "the gate's own statement must be accepted");

  // The competing implementation's shape: code + permissions_json only.
  await assert.rejects(
    () => world.d1(roleDefinitionInsert("preview_thin", ["bookings.view"], ["code", "permissions_json"])),
    /NOT NULL constraint failed: role_definitions\.(name|description|updated_at)/,
    "a role row of only code and permissions_json must be rejected, as the real database rejects it",
  );
  assert.equal(world.tables.role_definitions.length, 1, "and nothing may be written");
});

test("B — no schema is copied into the gate, so there is nothing to drift", () => {
  const source = readFileSync(new URL("./e2e/release-preview-gate.mjs", import.meta.url), "utf8");
  for (const table of REQUIRED_TABLES) {
    assert.ok(!new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`).test(source),
      `${table}'s DDL must not be duplicated here — it would drift from what the deployed candidate creates`);
  }
  assert.match(source, /ddlFromCheckout\(CANDIDATE_DIR, table\)/, "the CLI must read it from the candidate checkout");
});

test("B — the DDL extractor balances parentheses rather than stopping at the first bracket", () => {
  const source = "x CREATE TABLE IF NOT EXISTS t (a TEXT NOT NULL DEFAULT (''), b INTEGER NOT NULL) y";
  assert.equal(extractDdl(source, "t"), "CREATE TABLE IF NOT EXISTS t (a TEXT NOT NULL DEFAULT (''), b INTEGER NOT NULL)");
  assert.equal(extractDdl(source, "absent"), null);
  // A column with a DEFAULT is not required: the database supplies it.
  assert.deepEqual(requiredColumnsOf(extractDdl(source, "t")), ["b"]);
});

// --- F. mandatory evidence ---------------------------------------------------------------------

test("F — unreadable provider evidence FAILS instead of reporting a passing zero", async () => {
  // Two defects lived in the line this replaces. It swallowed its own error and substituted zero — and it
  // named a table this product does not have, so on a real preview it could only ever have thrown. The
  // claim now comes from deployed configuration, and it is still mandatory.
  const report = await run(makeWorld(), { providerActivation: async () => null });
  const activation = report.checks.find((c) => c.name.includes("provider activation"));
  assert.ok(activation && !activation.ok, "unreadable provider evidence must fail the gate");
  assert.match(activation.detail, /NOT RUN/, "and be recorded as not run, with the reason");
  assert.ok(report.unavailable.includes(activation.name));

  const threw = await run(makeWorld(), { providerActivation: async () => { throw new Error("wrangler exploded"); } });
  assert.ok(failed(threw, "provider activation").length === 1, "an adapter that throws must fail, not be swallowed");
});

test("F — provider activation that is ON fails the gate", async () => {
  const live = await run(makeWorld(), {
    providerActivation: async () => ({ ...PROVIDER_ACTIVATION_VARS, PAWSPACE_PROVIDER_MARKETPLACE_LIVE: "true" }),
  });
  const check = live.checks.find((c) => c.name.includes("provider activation"));
  assert.ok(check && !check.ok, "a preview that went out with the marketplace live must fail");
  assert.match(check.detail, /PAWSPACE_PROVIDER_MARKETPLACE_LIVE=true/);

  const unset = await run(makeWorld(), { providerActivation: async () => ({}) });
  assert.ok(failed(unset, "provider activation").length === 1, "variables that are not set at all must fail too");
});

test("F — the provider table this product does not have is no longer queried", () => {
  const source = readFileSync(new URL("./e2e/release-preview-gate.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /FROM providers/, "no such table exists in this product");
  assert.doesNotMatch(source, /marketplace_live=1/, "nor those columns, in any file under app, lib or worker");
  // And the claim that replaced it names variables the deploy really writes.
  const config = readFileSync(new URL("../scripts/release-preview-config.mjs", import.meta.url), "utf8");
  for (const [name, expected] of Object.entries(PROVIDER_ACTIVATION_VARS)) {
    assert.match(config, new RegExp(`${name}:\\s*"${expected}"`), `${name} must be written as ${expected}`);
  }
});

test("F — hosted-SHA evidence is required: unreadable fails, and so does the wrong sha", async () => {
  const unreadable = await run(makeWorld(), { hostedSha: async () => null });
  const marker = unreadable.checks.find((c) => c.name.includes("hosted version marker"));
  assert.ok(marker && !marker.ok, "a marker that cannot be read must fail");
  assert.match(marker.detail, /NOT RUN/);

  const threw = await run(makeWorld(), { hostedSha: async () => { throw new Error("wrangler exploded"); } });
  assert.ok(failed(threw, "hosted version marker").length === 1, "an adapter that throws must fail, not be swallowed");

  const drifted = await run(makeWorld(), { hostedSha: async () => "some other build" });
  assert.ok(failed(drifted, "hosted version marker").length === 1, "a marker for a different build is deployment drift");
});

test("F — Worker-log evidence is required, and a 5xx or exception in it fails the gate", async () => {
  const unsampled = await run(makeWorld(), { workerLog: async () => null });
  const logCheck = unsampled.checks.find((c) => c.name.includes("Worker log"));
  assert.ok(logCheck && !logCheck.ok, "a log that could not be sampled must fail");
  assert.match(logCheck.detail, /NOT RUN/);

  assert.ok(failed(await run(makeWorld(), { workerLog: async () => '{"outcome":"exception"}' }), "Worker log").length === 1);
  assert.ok(failed(await run(makeWorld(), { workerLog: async () => '{"status":503}' }), "Worker log").length === 1);
});

test("F — NO check can be recorded as not run and still leave the gate passing", async () => {
  const source = readFileSync(new URL("./e2e/release-preview-gate.mjs", import.meta.url), "utf8");
  const helper = source.slice(source.indexOf("const unavailable ="), source.indexOf("// No constant fallback"));
  assert.match(helper, /ok:\s*false/, "an unavailable check is a failing check");
  assert.match(helper, /failures\+\+/, "and it must count");
  assert.doesNotMatch(source, /ok:\s*null/, "there is no third, softer outcome");
  assert.doesNotMatch(source, /\.catch\(\(\) => 0\)/, "and nothing may swallow its own failure into a zero");
  assert.match(source, /report\.failures === 0 && report\.authHarness !== "unavailable" && report\.schema !== "unavailable"/,
    "the exit condition must cover both halt paths as well as the failure count");

  // Behaviourally, for every kind of unavailability this gate can encounter.
  for (const over of [
    { hostedSha: async () => null },
    { workerLog: async () => null },
    { ddl: async () => null },
    { providerActivation: async () => null },
  ]) {
    const report = await run(makeWorld(), over);
    assert.notEqual(report.failures, 0, `an unavailable check must fail the gate: ${Object.keys(over)}`);
  }
  const providers = await run(makeWorld(), { providerActivation: async () => null });
  assert.notEqual(providers.failures, 0, "including unreadable provider evidence");
});

// --- B (consolidated) — the fresh-D1 bootstrap covers everything the gate touches ----------------
//
// The support tables were the visible half. The other half is quieter: the gate SELECTs the five booking
// tables before any request reaches the route, so on an empty database those reads fail too — and
// canonical_customers exists only as a side effect of a booking the gate may never get to make.

test("B — an empty database rejects the gate's READS too, not just its seeds", async () => {
  const world = makeWorld();
  // The first thing the anonymous block does after seeding is snapshot all five booking tables.
  for (const table of TOUCHED_TABLES) {
    await assert.rejects(() => world.d1(`SELECT COUNT(*) n FROM ${table} WHERE 1=1`),
      new RegExp(`no such table: ${table}`), `${table} must not be readable before it is created`);
  }
  await assert.rejects(() => world.d1("SELECT COUNT(*) n FROM canonical_customers WHERE 1=1"),
    /no such table: canonical_customers/);
});

test("B — every CREATE runs before the first INSERT or SELECT", async () => {
  const world = makeWorld();
  const report = await run(world, { ddl: realDdl });
  assert.equal(report.failures, 0, report.checks.filter((c) => !c.ok).map((c) => c.name).join("; "));
  const kinds = world.sqlLog.map((s) => s.kind);
  const lastCreate = kinds.lastIndexOf("CREATE");
  const firstUse = kinds.findIndex((k) => k !== "CREATE");
  assert.ok(lastCreate >= 0 && firstUse >= 0, "the run must contain both DDL and DML");
  assert.ok(lastCreate < firstUse,
    `DDL must finish before any read or write: last CREATE at ${lastCreate}, first ${kinds[firstUse]} at ${firstUse}`);
  assert.deepEqual(world.sqlLog.slice(0, REQUIRED_TABLES.length).map((s) => s.table), REQUIRED_TABLES);
});

test("B — removing ANY one of the twelve fails the gate, before sign-in", async () => {
  for (const missing of REQUIRED_TABLES) {
    const world = makeWorld();
    const report = await run(world, { ddl: async (table) => (table === missing ? null : realDdl(table)) });
    assert.equal(report.schema, "unavailable", `dropping ${missing} must halt the gate`);
    assert.ok(report.failures > 0, `dropping ${missing} must fail`);
    assert.ok(!world.httpLog.some((r) => r.path === "/api/staging-login"),
      `dropping ${missing} must stop the run before it tries to sign anyone in`);
    assert.ok(!report.checks.some((c) => c.name.includes("real UAT sessions")),
      `dropping ${missing} must not claim authorization results it never obtained`);
  }
});

// --- DDL authority: the mapped source, not an arbitrary first match -----------------------------

test("every required table has exactly one mapped authoritative source", () => {
  assert.deepEqual(Object.keys(AUTHORITATIVE_DDL_SOURCES).sort(), [...REQUIRED_TABLES].sort(),
    "a table with no mapped owner would fall back to whatever the directory walk found first");
});

test("canonical_customers comes from the mapped booking route, not an arbitrary first match", async () => {
  // This is the case that makes the map necessary rather than tidy: the product declares
  // canonical_customers twice, with DIFFERENT defaults, and a first-match walk returns whichever file
  // it reached first. The preview must get the definition the route under test actually executes.
  const mapped = await realDdl("canonical_customers");
  const fromRoute = extractDdl(readFileSync(new URL("../app/api/canonical-bookings/route.ts", import.meta.url), "utf8"), "canonical_customers");
  assert.equal(mapped, fromRoute, "the mapped source must be the one that supplies it");
  assert.equal(AUTHORITATIVE_DDL_SOURCES.canonical_customers, "app/api/canonical-bookings/route.ts");

  const elsewhere = extractDdl(readFileSync(new URL("../lib/customer-account.ts", import.meta.url), "utf8"), "canonical_customers");
  assert.ok(elsewhere, "the second definition must still exist, or this test has stopped proving anything");
  assert.notEqual(elsewhere, mapped, "and it must genuinely differ, or the map is untested here");
});

test("the scheduling tables come from the route that writes them", async () => {
  // uat-scheduling writes BOTH the assignment decision and the reservation rows this gate stands in for;
  // provider-capacity-control also declares scheduling_reservations but only reserves against capacity.
  assert.equal(AUTHORITATIVE_DDL_SOURCES.scheduling_assignment_decisions, "app/api/uat-scheduling/route.ts");
  assert.equal(AUTHORITATIVE_DDL_SOURCES.scheduling_reservations, "app/api/uat-scheduling/route.ts");
  const source = readFileSync(new URL("../app/api/uat-scheduling/route.ts", import.meta.url), "utf8");
  for (const table of ["scheduling_assignment_decisions", "scheduling_reservations"]) {
    assert.ok(/INSERT (OR REPLACE )?INTO scheduling_/.test(source), "the mapped route must be the one that writes them");
    assert.equal(await realDdl(table), extractDdl(source, table));
  }
});

test("identity and security tables come from lib/server-auth.ts, which sign-in runs through", async () => {
  for (const table of ["role_definitions", "app_users", "customer_identity_links"]) {
    assert.equal(AUTHORITATIVE_DDL_SOURCES[table], "lib/server-auth.ts");
    assert.ok(await realDdl(table), `${table} must be defined by its mapped owner`);
  }
});

test("a definition outside the mapped source cannot stand in for a missing one", () => {
  // An empty checkout: every table is defined SOMEWHERE in this repository, but nowhere the map points.
  const empty = new URL("./fixtures-that-do-not-exist/", import.meta.url).pathname;
  for (const table of REQUIRED_TABLES) {
    assert.equal(ddlFromCheckout(empty, table), null, `${table} must resolve to null, never to a substitute`);
  }
});

/** A throwaway checkout with files placed exactly where the caller asks. */
function fakeCheckout(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ddl-authority-"));
  for (const [relative, text] of Object.entries(files)) {
    const full = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return root;
}

test("the mapped source WINS over a different definition the walk would reach first", () => {
  // NON-VACUOUS BY CONSTRUCTION. Against this repository a first-match walk happens to reach
  // app/api/canonical-bookings/route.ts before lib/customer-account.ts, so comparing the two there
  // proves nothing about the map — it passes with or without one. Here the decoy is deliberately placed
  // where a walk reaches it FIRST (app/ before lib/, "aaa" before anything else), and it differs.
  const mapped = "CREATE TABLE IF NOT EXISTS role_definitions (code TEXT PRIMARY KEY, name TEXT NOT NULL)";
  const decoy = "CREATE TABLE IF NOT EXISTS role_definitions (code TEXT PRIMARY KEY, name TEXT)";
  const root = fakeCheckout({
    "app/api/aaa-decoy/route.ts": decoy,
    "lib/server-auth.ts": mapped,
  });
  try {
    assert.equal(ddlFromCheckout(root, "role_definitions"), mapped,
      "the authority is the mapped file, not whichever file the directory walk reached first");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a table defined ONLY outside its mapped source resolves to null, not to the substitute", () => {
  const root = fakeCheckout({
    "app/api/aaa-decoy/route.ts": "CREATE TABLE IF NOT EXISTS customer_identity_links (email TEXT PRIMARY KEY)",
    "lib/server-auth.ts": "// the mapped owner no longer declares it",
  });
  try {
    assert.equal(ddlFromCheckout(root, "customer_identity_links"), null,
      "a definition elsewhere must not silently replace the mapped owner's");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- fail closed: ambiguous, malformed, or not a plain CREATE TABLE ------------------------------

test("two DIFFERENT definitions inside the authoritative source fail closed", () => {
  const source = `
    CREATE TABLE IF NOT EXISTS t (a TEXT PRIMARY KEY, b TEXT NOT NULL)
    CREATE TABLE IF NOT EXISTS t (a TEXT PRIMARY KEY, b TEXT)
  `;
  assert.throws(() => extractDdl(source, "t"), /2 different definitions .* refusing to guess/s);
});

test("the same definition written twice is one definition, not an ambiguity", () => {
  const source = `
    CREATE TABLE IF NOT EXISTS t (a TEXT PRIMARY KEY, b TEXT NOT NULL)
    CREATE   TABLE IF NOT EXISTS  t (\n  a TEXT PRIMARY KEY,\n  b TEXT NOT NULL\n)
  `;
  assert.match(extractDdl(source, "t"), /^CREATE TABLE IF NOT EXISTS t \(a TEXT PRIMARY KEY, b TEXT NOT NULL\)$/);
});

test("a malformed definition fails closed instead of being skipped", () => {
  const source = "CREATE TABLE IF NOT EXISTS t (a TEXT PRIMARY KEY, b TEXT NOT NULL";
  assert.equal(extractAllDdl(source, "t").malformed, 1);
  assert.throws(() => extractDdl(source, "t"), /does not parse — unbalanced parentheses/);
});

test("a parenthesis inside a quoted default does not truncate the statement", () => {
  const sql = "CREATE TABLE IF NOT EXISTS t (a TEXT PRIMARY KEY, note TEXT NOT NULL DEFAULT ')(')";
  const found = extractAllDdl(`const ddl = \`${sql}\`;`, "t");
  assert.equal(found.malformed, 0);
  assert.equal(found.statements[0], sql, "a quote-blind scan would have closed the statement on data");
});

test("SABOTAGE — an ambiguous authoritative source halts the gate before sign-in", async () => {
  const world = makeWorld();
  const report = await run(world, {
    ddl: async (table) => {
      if (table !== "canonical_pets") return realDdl(table);
      throw new Error("canonical_pets: 2 different definitions in its authoritative source");
    },
  });
  assert.equal(report.schema, "unavailable");
  const failure = report.checks.find((c) => c.name.includes("canonical_pets"));
  assert.ok(failure && !failure.ok && /NOT RUN/.test(failure.detail), "it must be recorded as not run, with the reason");
  assert.ok(!world.httpLog.some((r) => r.path === "/api/staging-login"));
});

test("the tables the gate SEEDS are a subset of the tables it BOOTSTRAPS", () => {
  // SUPPORT_TABLES is the five the gate writes to during setup; REQUIRED_TABLES adds the six the booking
  // route owns and the provider table, making twelve. Keeping the relation asserted is what stops the two
  // lists drifting apart: a support table added without being bootstrapped would fail on the very first
  // dispatch, not here.
  for (const table of SUPPORT_TABLES) {
    assert.ok(REQUIRED_TABLES.includes(table), `${table} is seeded but never created`);
  }
  assert.equal(SUPPORT_TABLES.length, 5);
  assert.equal(REQUIRED_TABLES.length, 12, "five support, six from the booking route, one provider table");
  // The provider table is bootstrapped but never written by a booking, so it must NOT be in the
  // snapshot set: counting it there would make every zero-write comparison include a table no refusal
  // could ever touch.
  assert.ok(REQUIRED_TABLES.includes("canonical_providers"));
  assert.ok(!TOUCHED_TABLES.includes("canonical_providers"));
  assert.equal(TOUCHED_TABLES.length, 5);
});

// ---------------------------------------------------------------------------
// The last pre-created table. `providers` was kept in the mock as "a preview in which a provider route
// has already run" — but no such preview exists: nothing in this product creates that table, and two of
// the three columns the old check filtered on are in no source file at all. The mock now starts with
// nothing whatsoever, which is the only state a freshly created preview D1 is ever in.
// ---------------------------------------------------------------------------

test("EMPTY-D1 — the mock starts with no tables at all, including providers", async () => {
  const world = makeWorld();
  assert.deepEqual(Object.keys(world.tables), [], "a fresh preview database has nothing in it");
  await assert.rejects(() => world.d1("SELECT COUNT(*) n FROM providers WHERE live=1"), /no such table: providers/,
    "the table the old check queried must throw, not answer zero");
  for (const table of REQUIRED_TABLES) {
    await assert.rejects(() => world.d1(`SELECT COUNT(*) n FROM ${table} WHERE 1=1`),
      new RegExp(`no such table: ${table}`), `${table} must throw before it is bootstrapped`);
  }
});

test("EMPTY-D1 — all twelve bootstrap, and the complete gate then runs against that empty database", async () => {
  const world = makeWorld();
  const report = await run(world);
  assert.equal(report.failures, 0, report.checks.filter((c) => !c.ok).map((c) => c.name).join("; "));
  assert.deepEqual(Object.keys(world.tables).sort(), [...REQUIRED_TABLES].sort(), "exactly the twelve, no more");
  assert.ok(world.tables.canonical_providers, "including the provider table");
  assert.ok(world.tables.canonical_bookings.length > 0, "and the run really created bookings");
});

test("EMPTY-D1 — withholding the provider table halts the gate by name", async () => {
  const report = await run(makeWorld(), {
    ddl: async (table) => (table === "canonical_providers" ? null : ddlFromCheckout(CANDIDATE_ROOT, table)),
  });
  assert.equal(report.schema, "unavailable", "the gate must halt at the schema step");
  assert.ok(report.checks.some((c) => c.unavailable && c.name.includes("canonical_providers")));
  assert.ok(!report.checks.some((c) => c.name.includes("anonymous")), "no HTTP result may be claimed");
});

test("SABOTAGE — restoring the pre-created providers table is caught", async () => {
  // The mock exactly as it was: one table handed over that nothing could have created.
  const preCreated = () => {
    const world = makeWorld();
    world.tables.providers = [];
    return world;
  };
  assert.notDeepEqual(Object.keys(preCreated().tables), [],
    "the sabotaged mock is not empty, and the empty-D1 assertion above is what catches it");

  // And the consequence, measured: the sabotaged mock answers a passing zero for a table that cannot
  // exist, where the honest one throws. That difference is the whole defect.
  const answer = await preCreated().d1("SELECT COUNT(*) n FROM providers WHERE live=1 OR marketplace_live=1");
  assert.equal(answer[0]?.n, 0, "the sabotaged mock answers zero");
  await assert.rejects(() => makeWorld().d1("SELECT COUNT(*) n FROM providers WHERE live=1 OR marketplace_live=1"),
    /no such table: providers/, "and the honest mock throws, as a real preview would");
});

test("SOURCE MAP — the provider table is mapped to the module that owns it", async () => {
  assert.equal(AUTHORITATIVE_DDL_SOURCES.canonical_providers, "lib/partner-otp.ts");
  const ddl = ddlFromCheckout(CANDIDATE_ROOT, "canonical_providers");
  assert.ok(ddl.startsWith("CREATE TABLE IF NOT EXISTS canonical_providers ("));
  // It is the only module that declares it, and it declares it once, so there is nothing to disambiguate.
  const found = extractAllDdl(readFileSync(path.join(CANDIDATE_ROOT, "lib/partner-otp.ts"), "utf8"), "canonical_providers");
  assert.equal(found.statements.length, 1);
  assert.equal(found.malformed, 0);
});
