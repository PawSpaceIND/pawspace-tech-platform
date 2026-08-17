import test from "node:test";
import assert from "node:assert/strict";
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGate, boundedAll, assertRunTag, TOUCHED_TABLES, BOOTSTRAP_TABLES, SCHEMA_SOURCE_MAP, PROVIDER_ACTIVATION_VARS, extractDdl, extractAllDdl, normalizeDdl, authoritativeDdl, allDeclarationsOf, requiredColumnsOf, roleDefinitionInsert } from "./e2e/release-preview-gate.mjs";

/**
 * The repository itself stands in for the candidate checkout, and the DDL the mock world enforces is the
 * REAL product DDL, extracted by the same function the CLI uses. A fixture schema written here would turn
 * every "required column" assertion below into a test of the fixture.
 */
const CANDIDATE_ROOT = new URL("..", import.meta.url).pathname;
const realDdl = async (table) => authoritativeDdl(CANDIDATE_ROOT, table);

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
  // GENUINELY EMPTY, exactly like a freshly created preview D1: no tables at all.
  //
  // The previous version pre-created the five booking tables and `providers`, with a comment claiming the
  // product route creates them before this gate looks. It does not — the gate's first snapshot is taken
  // around an ANONYMOUS request, which the gateway refuses before the handler, and therefore before
  // ensureTables, ever runs. Pre-creating them is what made the "empty-D1" proof vacuous, and would have
  // let the first real dispatch die on `no such table: canonical_bookings`.
  //
  // Every read or write of a table nothing has created now throws, the way D1 throws. `required` is
  // populated from the same authoritative DDL the gate bootstraps with, so an INSERT missing a NOT NULL
  // column fails here for the reason it fails there.
  const tables = {};
  const required = {};
  const sessions = new Map();
  const httpLog = [];
  let inFlight = 0, maxInFlight = 0;

  const permissionsFor = (email) => {
    const user = tables.app_users.find((u) => u.email === email);
    const role = tables.role_definitions.find((r) => r.code === user?.role_code);
    return role ? JSON.parse(role.permissions_json) : [];
  };

  const d1 = async (sql) => {
    const create = sql.match(/^CREATE TABLE IF NOT EXISTS (\w+) \(/);
    if (create) {
      required[create[1]] = requiredColumnsOf(sql);
      tables[create[1]] = tables[create[1]] || [];
      return [];
    }
    const insert = sql.match(/^INSERT OR REPLACE INTO (\w+) \(([^)]*)\) VALUES \((.*)\)$/s);
    if (insert) {
      const [, table, cols, vals] = insert;
      const keys = cols.split(",").map((c) => c.trim());
      const values = vals.match(/'(?:[^']|'')*'|[^,]+/g).map((v) => v.trim().replace(/^'|'$/g, "").replace(/''/g, "'"));
      const row = Object.fromEntries(keys.map((k, i) => [k, values[i]]));
      // Real database behaviour, and the reason the gate must create these tables before it seeds them.
      if (!tables[table]) throw new Error(`no such table: ${table}`);
      for (const column of required[table] ?? []) {
        if (!(column in row)) throw new Error(`NOT NULL constraint failed: ${table}.${column}`);
      }
      tables[table] = tables[table] || [];
      const pk = keys[0];
      const existing = tables[table].findIndex((r) => r[pk] === row[pk]);
      if (existing >= 0) tables[table][existing] = row; else tables[table].push(row);
      return [];
    }
    const count = sql.match(/^SELECT COUNT\(\*\) n FROM (\w+)(?: WHERE (.*))?$/s);
    if (count) {
      const [, table, where] = count;
      // A table nothing has created cannot be counted. Returning zero for it is exactly how a missing
      // table became a passing claim in the version this replaces.
      if (faults.unreadable === table) throw new Error(`could not read ${table}`);
      if (!tables[table]) throw new Error(`no such table: ${table}`);
      const rows = tables[table];
      if (!where || where === "1=1") return [{ n: rows.length }];
      const like = where.match(/schedule_group_id LIKE '([^']*)%'/);
      if (like) return [{ n: rows.filter((r) => String(r.schedule_group_id || "").startsWith(like[1])).length }];
      const eq = where.match(/customer_id='([^']*)' AND source_pet_id='([^']*)'/);
      if (eq) return [{ n: rows.filter((r) => r.customer_id === eq[1] && r.source_pet_id === eq[2]).length }];
      return [{ n: rows.length }];
    }
    if (/LEFT JOIN canonical_bookings/.test(sql)) return [{ n: 0 }];
    if (/JOIN canonical_bookings/.test(sql)) {
      const table = sql.match(/FROM (\w+)/)[1];
      const like = sql.match(/LIKE '([^']*)%'/);
      const bookingIds = new Set(tables.canonical_bookings
        .filter((b) => !like || String(b.schedule_group_id).startsWith(like[1])).map((b) => b.id));
      return [{ n: (tables[table] || []).filter((r) => bookingIds.has(r.booking_id)).length }];
    }
    if (/GROUP BY source_pet_id HAVING COUNT\(\*\)>1/.test(sql)) {
      // Scoped by customer_id, exactly as the gate's SQL is. Two runs share source ids like "swarm-0"
      // under DIFFERENT customers; ignoring the filter would call that a duplicate when it is not.
      const owner = sql.match(/customer_id='([^']*)'/)?.[1];
      const seen = {};
      for (const p of tables.canonical_pets) {
        if (owner && p.customer_id !== owner) continue;
        if (String(p.source_pet_id).startsWith("swarm-")) seen[p.source_pet_id] = (seen[p.source_pet_id] || 0) + 1;
      }
      return [{ n: Object.values(seen).filter((n) => n > 1).length }];
    }
    const select = sql.match(/^SELECT ([\w,]+) FROM (\w+) WHERE id='([^']*)'$/);
    if (select) {
      const row = (tables[select[2]] || []).find((r) => r.id === select[3]);
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
        const user = tables.app_users.find((u) => u.email === email && u.status === "active");
        const role = user && tables.role_definitions.find((r) => r.code === user.role_code);
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
          body: { bookings: tables.canonical_bookings.map((b) => ({ ...b, pets: tables.canonical_pets.filter((p) => JSON.parse(b.pet_ids_json).includes(p.id)) })) },
        };
      }
      if (!perms.includes("scheduling.book")) return { status: 403, body: { error: "denied" }, headers: {} };

      // Ownership before the replay lookup, as requireCustomerOwnership runs before it in the route.
      const link = tables.customer_identity_links.find((l) => l.email === email);
      if (!faults.ownershipBypass && link && link.customer_id !== body.customer.id) {
        return { status: 403, body: { error: "Customer ownership denied" }, headers: {} };
      }

      const prior = tables.canonical_bookings.find((b) => b.idempotency_key === body.idempotencyKey || b.schedule_group_id === body.scheduleGroupId);
      if (prior) return { status: 200, body: { data: { bookingId: prior.id, duplicatePrevented: true, petIds: JSON.parse(prior.pet_ids_json) } }, headers: {} };

      for (const pet of body.pets) if (typeof pet.sourceId !== "string") return { status: 400, body: { error: "A pet source id must be text" }, headers: {} };
      const reservation = tables.scheduling_reservations.find((r) => r.group_id === body.scheduleGroupId);
      if (!reservation) return { status: 409, body: { error: "Scheduling must be assigned" }, headers: {} };
      if (reservation.city_id !== body.cityId || reservation.zone_id !== body.zoneId) {
        return { status: 409, body: { error: "The booking city/zone does not match" }, headers: {} };
      }

      const petIds = body.pets.map((pet) => {
        const existing = faults.duplicatePets ? null : tables.canonical_pets.find((p) => p.customer_id === body.customer.id && p.source_pet_id === pet.sourceId);
        if (existing) return existing.id;
        const id = faults.duplicatePets ? `PET-${body.customer.id}-${pet.sourceId}-${tables.canonical_pets.length}` : `PET-${body.customer.id}-${pet.sourceId}`;
        tables.canonical_pets.push({ id, customer_id: body.customer.id, name: pet.name, species: pet.species || "dog", breed: pet.breed ?? null, vaccination_status: "not_provided", source_pet_id: String(pet.sourceId) });
        return id;
      });
      const id = `BK-${tables.canonical_bookings.length}`;
      tables.canonical_bookings.push({ id, idempotency_key: body.idempotencyKey, schedule_group_id: body.scheduleGroupId, customer_id: body.customer.id, pet_ids_json: JSON.stringify(petIds) });
      tables.booking_payments.push({ id: `PAY-${id}`, booking_id: id });
      tables.provider_work_orders.push({ id: `WO-${id}`, booking_id: id });
      tables.booking_lifecycle_events.push({ id: `EV-${id}`, booking_id: id });
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
        tables.booking_lifecycle_events.push({ id: `leak-${tables.booking_lifecycle_events.length}`, booking_id: "none" });
      }
      return res;
    } finally { inFlight--; }
  };

  return { http, d1, tables, required, httpLog, stats: () => ({ maxInFlight }) };
}

const ENV = { EXPECTED_SHA: "b52e7dc1c04efa36d7e89e1b06ad252f9cf5ab6e", ACCESS_CODE, RUN_TAG: "9001-1" };
const silent = () => {};
/** What a correct world supplies for the three mandatory-evidence adapters. */
const okHostedSha = async () => `{"annotations":{"workers/tag":"${ENV.EXPECTED_SHA}"}}`;
const okWorkerLog = async () => '{"outcome":"ok","status":200}';
/** A deployed configuration with activation off, which is what the preview config script writes. */
const okProviderActivation = async () => ({ ...PROVIDER_ACTIVATION_VARS });
const run = (world, over = {}) => runGate({
  http: world.http, d1: world.d1, ddl: realDdl, hostedSha: okHostedSha, workerLog: okWorkerLog,
  providerActivation: okProviderActivation,
  env: ENV, log: silent, swarmSize: 6, concurrency: 3, ...over,
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
  assert.deepEqual(asked, BOOTSTRAP_TABLES, "all five, in order, and before the first seed");
  for (const table of BOOTSTRAP_TABLES) {
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
  assert.ok(report.failures >= BOOTSTRAP_TABLES.length, `each missing table must count as a failure, saw ${report.failures}`);
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
  for (const table of BOOTSTRAP_TABLES) {
    assert.ok(!new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`).test(source),
      `${table}'s DDL must not be duplicated here — it would drift from what the deployed candidate creates`);
  }
  assert.match(source, /authoritativeDdl\(CANDIDATE_DIR, table\)/, "the CLI must read it from the candidate checkout, through the explicit source map");
});

test("B — the DDL extractor balances parentheses rather than stopping at the first bracket", () => {
  const source = "x CREATE TABLE IF NOT EXISTS t (a TEXT NOT NULL DEFAULT (''), b INTEGER NOT NULL) y";
  assert.equal(extractDdl(source, "t"), "CREATE TABLE IF NOT EXISTS t (a TEXT NOT NULL DEFAULT (''), b INTEGER NOT NULL)");
  assert.equal(extractDdl(source, "absent"), null);
  // A column with a DEFAULT is not required: the database supplies it.
  assert.deepEqual(requiredColumnsOf(extractDdl(source, "t")), ["b"]);

  // And every declaration is found, not just the first — which is what makes ambiguity detectable at all.
  const twice = `${source} and again CREATE TABLE IF NOT EXISTS t (a TEXT) z`;
  const all = extractAllDdl(twice, "t");
  assert.equal(all.length, 2, "both declarations must be returned");
  assert.equal(new Set(all.map(normalizeDdl)).size, 2, "and they differ, so this file would be ambiguous");
  assert.deepEqual(extractAllDdl(source, "absent"), [], "a table nobody declares yields nothing");
});

// --- F. mandatory evidence ---------------------------------------------------------------------

test("F — unreadable provider evidence FAILS instead of reporting a passing zero", async () => {
  // Two defects in one line, now both gone: it swallowed its own error and substituted zero, and it named
  // a table this product does not have. The claim is now made from the deployed configuration, and it is
  // still mandatory — an unreadable one fails.
  const report = await run(makeWorld(), { providerActivation: async () => null });
  const activation = report.checks.find((c) => c.name.includes("provider activation"));
  assert.ok(activation && !activation.ok, "unreadable provider evidence must fail the gate");
  assert.match(activation.detail, /NOT RUN/, "and be recorded as not run, with the reason");
  assert.ok(report.unavailable.includes(activation.name));

  const threw = await run(makeWorld(), { providerActivation: async () => { throw new Error("wrangler exploded"); } });
  assert.ok(failed(threw, "provider activation").length === 1, "an adapter that throws must fail, not be swallowed");
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

// ---------------------------------------------------------------------------
// EMPTY-D1 — the proof that was vacuous, and is not any more.
//
// The gate bootstrapped five tables and then snapshotted five others it had not created. Its first
// snapshot is taken around an ANONYMOUS request, so `/api/canonical-bookings`'s own ensureTables has never
// run — the gateway refuses the request before the handler. On a real fresh preview D1 the run dies on
// `no such table: canonical_bookings`, and nothing here noticed because the mock pre-created them.
//
// The mock is now genuinely empty, so these tests can ask the question directly: which tables must exist
// before the gate touches anything, and what happens when one of them does not.
// ---------------------------------------------------------------------------

const TOUCHED_ORDER = ["canonical_bookings", "canonical_pets", "booking_payments", "provider_work_orders", "booking_lifecycle_events"];
/** The bootstrap with a chosen table withheld — a candidate that fails to declare exactly one table. */
const ddlWithout = (...withheld) => async (table) => (withheld.includes(table) ? null : authoritativeDdl(CANDIDATE_ROOT, table));

test("EMPTY-D1 — the five-table bootstrap this replaces dies on the first booking-table snapshot", async () => {
  // Exactly the previous behaviour: bootstrap only the security and scheduling tables, then let the gate
  // reach its first snapshot. This is the failure the first real dispatch would have hit.
  const fiveOnly = ["app_users", "role_definitions", "customer_identity_links", "scheduling_assignment_decisions", "scheduling_reservations"];
  const report = await run(makeWorld(), { ddl: async (table) => (fiveOnly.includes(table) ? authoritativeDdl(CANDIDATE_ROOT, table) : null) });
  assert.equal(report.schema, "unavailable", "the gate must halt at the schema step rather than reach a snapshot it cannot take");
  const missed = report.checks.filter((c) => c.unavailable).map((c) => c.name);
  for (const table of [...TOUCHED_ORDER, "canonical_customers", "canonical_providers"]) {
    assert.ok(missed.some((name) => name.includes(table)), `${table} must be reported as missing, not discovered later by a snapshot`);
  }
  assert.equal(missed.length, 7, `the five-table bootstrap leaves exactly seven tables unmade, saw ${missed.length}`);
});

test("EMPTY-D1 — all twelve tables let the complete gate run against an empty database", async () => {
  const world = makeWorld();
  assert.deepEqual(Object.keys(world.tables), [], "the mock must start with no tables whatsoever");
  const report = await run(world);
  assert.equal(report.failures, 0, report.checks.filter((c) => !c.ok).map((c) => c.name).join("; "));
  assert.notEqual(report.schema, "unavailable");
  assert.notEqual(report.authHarness, "unavailable");
  // Every one of the twelve exists afterwards, and the five snapshot tables carry rows the gate created.
  assert.deepEqual(Object.keys(world.tables).sort(), [...BOOTSTRAP_TABLES].sort());
  assert.equal(BOOTSTRAP_TABLES.length, 12, "twelve tables, mapped one by one");
  assert.ok(world.tables.canonical_bookings.length > 0, "the run really did create bookings");
});

test("EMPTY-D1 — withholding canonical_bookings fails before the anonymous snapshot, not during it", async () => {
  const report = await run(makeWorld(), { ddl: ddlWithout("canonical_bookings") });
  assert.equal(report.schema, "unavailable", "the gate must stop at the schema step");
  assert.ok(report.checks.some((c) => c.unavailable && c.name.includes("canonical_bookings")));
  // And it must not have got as far as an HTTP request, which is what "before the snapshot" means.
  assert.ok(!report.checks.some((c) => c.name.includes("anonymous")), "no anonymous result may be reported");
  assert.ok(!report.checks.some((c) => c.name.includes("real UAT sessions")), "and no session result either");
});

test("EMPTY-D1 — withholding ANY touched table fails its own snapshot table by name", async () => {
  for (const table of TOUCHED_ORDER) {
    const report = await run(makeWorld(), { ddl: ddlWithout(table) });
    assert.equal(report.schema, "unavailable", `${table}: the gate must halt`);
    const named = report.checks.filter((c) => c.unavailable && c.name.includes(table));
    assert.equal(named.length, 1, `${table} must be named exactly once as unmade, saw ${named.length}`);
    assert.notEqual(report.failures, 0, `${table}: a missing table must fail the gate`);
  }
});

test("EMPTY-D1 — withholding the provider table fails, and unreadable provider evidence fails too", async () => {
  const missingTable = await run(makeWorld(), { ddl: ddlWithout("canonical_providers") });
  assert.equal(missingTable.schema, "unavailable", "the provider table is one of the twelve");
  assert.ok(missingTable.checks.some((c) => c.unavailable && c.name.includes("canonical_providers")));

  // And the provider CLAIM is mandatory in its own right, independently of the table.
  const unreadable = await run(makeWorld(), { providerActivation: async () => null });
  assert.ok(failed(unreadable, "provider activation").length === 1, "unreadable provider evidence must fail");
});

test("EMPTY-D1 — no missing table can become a passing zero", async () => {
  // The shape being locked out: a COUNT over a table nothing created answering 0 rather than throwing.
  const world = makeWorld();
  await assert.rejects(() => world.d1("SELECT COUNT(*) n FROM canonical_bookings WHERE 1=1"), /no such table: canonical_bookings/);
  await assert.rejects(() => world.d1("SELECT COUNT(*) n FROM canonical_providers WHERE 1=1"), /no such table: canonical_providers/);
  await assert.rejects(() => world.d1("INSERT OR REPLACE INTO app_users (id,email) VALUES ('a','b')"), /no such table: app_users/);
  // Every one of the twelve, so none of them is quietly special-cased in the mock.
  for (const table of BOOTSTRAP_TABLES) {
    await assert.rejects(() => world.d1(`SELECT COUNT(*) n FROM ${table} WHERE 1=1`), new RegExp(`no such table: ${table}`), table);
  }
  // And a read that fails for a reason OTHER than absence must also fail rather than answer zero.
  const flaky = makeWorld({ unreadable: "canonical_bookings" });
  for (const table of BOOTSTRAP_TABLES) await flaky.d1(authoritativeDdl(CANDIDATE_ROOT, table));
  await assert.rejects(() => flaky.d1("SELECT COUNT(*) n FROM canonical_bookings WHERE 1=1"), /could not read canonical_bookings/);
});

// --- the source map itself ----------------------------------------------------------------------

test("SOURCE MAP — canonical_customers comes from the mapped canonical-bookings route, not a first match", () => {
  const sites = allDeclarationsOf(CANDIDATE_ROOT, "canonical_customers");
  const distinct = [...new Set(sites.map((s) => s.normalized))];
  // The divergence is real, which is the whole reason the map exists.
  assert.equal(distinct.length, 2, `expected two distinct declarations of canonical_customers, saw ${distinct.length}`);
  const mapped = authoritativeDdl(CANDIDATE_ROOT, "canonical_customers");
  assert.equal(SCHEMA_SOURCE_MAP.canonical_customers, "app/api/canonical-bookings/route.ts");
  assert.match(mapped, /DEFAULT 'uat_customer_app'/, "the route under test defaults source to uat_customer_app");
  const other = sites.find((s) => s.file === "lib/customer-account.ts");
  assert.ok(other, "lib/customer-account.ts must still be the divergent one this map avoids");
  assert.match(other.ddl, /DEFAULT 'customer_app'/);
  assert.notEqual(normalizeDdl(mapped), other.normalized, "and the two must genuinely differ");
});

test("SOURCE MAP — every mapped source really declares its table, and agreement is recorded", () => {
  const divergent = [];
  for (const table of BOOTSTRAP_TABLES) {
    const mapped = authoritativeDdl(CANDIDATE_ROOT, table);
    assert.ok(mapped.startsWith(`CREATE TABLE IF NOT EXISTS ${table} (`), `${table} must come back as its own statement`);
    const distinct = [...new Set(allDeclarationsOf(CANDIDATE_ROOT, table).map((s) => s.normalized))];
    if (distinct.length > 1) divergent.push(`${table} (${distinct.length})`);
    // Where other modules agree, the mapped one is that agreed definition — not a third variant.
    if (distinct.length === 1) assert.equal(normalizeDdl(mapped), distinct[0], `${table}: the mapped definition must be the agreed one`);
  }
  // Recorded rather than asserted away: exactly one table diverges today, and it is the one above.
  assert.deepEqual(divergent, ["canonical_customers (2)"], `unexpected divergence: ${divergent.join(", ")}`);
});

test("SOURCE MAP — provider evidence names variables the deploy actually writes", () => {
  // The check this replaces queried `providers.live / marketplace_live / order_eligible`. None of those
  // exist in this product, which is why the claim moved to the deployed configuration.
  const configSource = readFileSync(new URL("../scripts/release-preview-config.mjs", import.meta.url), "utf8");
  for (const [name, expected] of Object.entries(PROVIDER_ACTIVATION_VARS)) {
    assert.ok(configSource.includes(name), `${name} must be written by the preview configuration script`);
    assert.match(configSource, new RegExp(`${name}:\\s*"${expected}"`), `${name} must be written as ${expected}`);
  }
  const gateSource = readFileSync(new URL("./e2e/release-preview-gate.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(gateSource, /FROM providers/, "the non-existent providers table must not be queried");
  assert.doesNotMatch(gateSource, /marketplace_live=1/, "nor its non-existent columns");
});

test("SOURCE MAP — missing, malformed or ambiguous authoritative DDL fails closed", async () => {
  // No mapping at all.
  assert.throws(() => authoritativeDdl(CANDIDATE_ROOT, "table_nobody_mapped"), /no authoritative source is mapped/);
  // A mapped file that is not there.
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "empty-candidate-"));
  assert.throws(() => authoritativeDdl(emptyRoot, "app_users"), /the authoritative source for app_users is missing/);
  // A mapped file that exists but declares nothing.
  fs.mkdirSync(path.join(emptyRoot, "lib"), { recursive: true });
  fs.writeFileSync(path.join(emptyRoot, "lib/server-auth.ts"), "export const nothing = true;\n");
  assert.throws(() => authoritativeDdl(emptyRoot, "app_users"), /does not declare app_users/);
  // The fixtures below are ASSEMBLED rather than written out, because the duplicate-schema guard further
  // down greps every infrastructure file for a literal declaration and should stay blunt enough to catch a
  // real one. A fixture that trips it would only teach us to loosen the guard.
  const declare = (table, columns) => `${["CREATE", "TABLE", "IF", "NOT", "EXISTS"].join(" ")} ${table} (${columns})`;
  // A mapped file that declares the same table two DIFFERENT ways: ambiguous, so unusable.
  fs.writeFileSync(path.join(emptyRoot, "lib/server-auth.ts"),
    `const a = \`${declare("app_users", "id TEXT PRIMARY KEY, email TEXT NOT NULL")}\`;\n` +
    `const b = \`${declare("app_users", "id TEXT PRIMARY KEY, email TEXT")}\`;\n`);
  assert.throws(() => authoritativeDdl(emptyRoot, "app_users"), /internally ambiguous/);
  // Identical repeats are not an ambiguity, whitespace included.
  fs.writeFileSync(path.join(emptyRoot, "lib/server-auth.ts"),
    `const a = \`${declare("app_users", "id TEXT PRIMARY KEY, email TEXT NOT NULL")}\`;\n` +
    `const b = \`${declare("app_users", "id TEXT PRIMARY KEY,  email TEXT NOT NULL")}\`;\n`);
  assert.ok(authoritativeDdl(emptyRoot, "app_users").includes("app_users"), "identical repeats must resolve");
  fs.rmSync(emptyRoot, { recursive: true, force: true });

  // And a candidate whose DDL cannot be obtained fails the gate rather than being skipped.
  const report = await run(makeWorld(), { ddl: async () => { throw new Error("unreadable candidate"); } });
  assert.equal(report.schema, "unavailable");
  assert.equal(report.checks.filter((c) => c.unavailable).length, BOOTSTRAP_TABLES.length);
});

test("SOURCE MAP — no hardcoded duplicate schema exists anywhere in the infrastructure", () => {
  const files = [
    "tests/e2e/release-preview-gate.mjs",
    "tests/release-preview-gate-behavior.test.mjs",
    "tests/release-preview-bootstrap.test.mjs",
    "scripts/release-preview-config.mjs",
    ".github/workflows/deploy-release-preview.yml",
  ];
  for (const file of files) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    for (const table of BOOTSTRAP_TABLES) {
      assert.ok(!new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`).test(source),
        `${file} must not carry its own ${table} schema — it would drift from the deployed one`);
    }
  }
});

// --- sabotage: restore the pre-created mock and the empty-D1 proof must catch it -----------------

test("SABOTAGE — restoring the mock's pre-created tables is detected by the empty-D1 proof", async () => {
  /** The mock exactly as it was: TOUCHED_TABLES and providers handed over ready-made. */
  const preCreated = (faults = {}) => {
    const world = makeWorld(faults);
    for (const table of TOUCHED_TABLES) world.tables[table] = [];
    world.tables.providers = [];
    return world;
  };

  // 1. The empty-D1 invariant catches it outright: this mock does not start empty, and a real fresh D1 does.
  const sabotaged = preCreated();
  assert.notDeepEqual(Object.keys(sabotaged.tables), [],
    "the sabotaged mock hands over six tables nothing created — which is what made the old proof vacuous");
  assert.deepEqual(Object.keys(makeWorld().tables), [], "and the honest mock hands over none");

  // 2. The vacuity itself, measured. Every table the gate's first snapshot reads answers a NUMBER on the
  //    sabotaged mock and THROWS on the honest one. That difference is the entire defect: on a real
  //    preview those reads throw, and the gate would have died where the sabotaged mock sails through.
  const honest = makeWorld();
  for (const table of TOUCHED_TABLES) {
    const answer = await sabotaged.d1(`SELECT COUNT(*) n FROM ${table} WHERE 1=1`);
    assert.equal(answer[0]?.n, 0, `${table}: the sabotaged mock answers a passing zero`);
    await assert.rejects(() => honest.d1(`SELECT COUNT(*) n FROM ${table} WHERE 1=1`),
      new RegExp(`no such table: ${table}`), `${table}: the honest mock must throw, as D1 throws`);
  }
  await assert.rejects(() => honest.d1("SELECT COUNT(*) n FROM providers WHERE live=1"), /no such table: providers/,
    "including the provider table this product does not even have");

  // 3. And the consequence for the gate: with the five-table bootstrap, the honest mock halts at the schema
  //    step and reports the seven tables it could not make, so no HTTP result is ever claimed. The
  //    sabotaged mock's pre-created tables are exactly what used to hide those seven.
  const fiveOnly = ["app_users", "role_definitions", "customer_identity_links", "scheduling_assignment_decisions", "scheduling_reservations"];
  const fiveTableDdl = async (table) => (fiveOnly.includes(table) ? authoritativeDdl(CANDIDATE_ROOT, table) : null);
  const halted = await run(makeWorld(), { ddl: fiveTableDdl });
  assert.equal(halted.schema, "unavailable");
  assert.equal(halted.checks.filter((c) => c.unavailable).length, 7);
  assert.ok(!halted.checks.some((c) => c.name.includes("anonymous")), "no anonymous result may be reported");
});
