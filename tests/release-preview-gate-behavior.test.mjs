import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runGate, boundedAll, TOUCHED_TABLES, SUPPORT_TABLES, extractDdl, ddlFromCheckout, requiredColumnsOf, roleDefinitionInsert, sanitizeRunTag } from "./e2e/release-preview-gate.mjs";

/**
 * The repository itself stands in for the candidate checkout: the DDL the mock world enforces is the
 * REAL product DDL, extracted by the same function the CLI uses. A fixture schema written here would
 * make every "required column" assertion below a test of the fixture.
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
function makeWorld(faults = {}) {
  // The five booking tables exist because the product route creates them on first request. The SUPPORT
  // tables deliberately do NOT: a freshly created preview database has none of them, and the gate has to
  // create them from the candidate's DDL before it can seed anything. `required` is populated from that
  // DDL, so an INSERT missing a NOT NULL column fails here the way it fails on real D1.
  const tables = Object.fromEntries(TOUCHED_TABLES.map((t) => [t, []]));
  tables.providers = [];
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
      const table = create[1];
      required[table] = requiredColumnsOf(sql);
      tables[table] = tables[table] || [];
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
      const pk = keys[0];
      const existing = tables[table].findIndex((r) => r[pk] === row[pk]);
      if (existing >= 0) tables[table][existing] = row; else tables[table].push(row);
      return [];
    }
    const count = sql.match(/^SELECT COUNT\(\*\) n FROM (\w+)(?: WHERE (.*))?$/s);
    if (count) {
      const [, table, where] = count;
      if (table === "providers" && faults.providersUnreadable) throw new Error("no such table: providers");
      const rows = tables[table] || [];
      if (!where || where === "1=1") return [{ n: rows.length }];
      const like = where.match(/schedule_group_id LIKE '([^']*)%'/);
      if (like) return [{ n: rows.filter((r) => String(r.schedule_group_id || "").startsWith(like[1])).length }];
      const eq = where.match(/customer_id='([^']*)' AND source_pet_id='([^']*)'/);
      if (eq) return [{ n: rows.filter((r) => r.customer_id === eq[1] && r.source_pet_id === eq[2]).length }];
      if (/live=1/.test(where)) return [{ n: 0 }];
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
      // The customer_id predicate is part of this query and must be honoured. Ignoring it made two runs
      // in ONE database look like duplicates: each run's swarm uses source ids swarm-0..n under its own
      // customer, so a customer-blind count reports every one of them twice. That is a mock defect, not
      // a finding — real D1 filters the rows before grouping them.
      const owner = sql.match(/customer_id='([^']*)'/);
      const seen = {};
      for (const p of tables.canonical_pets) {
        if (owner && p.customer_id !== owner[1]) continue;
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
        // app/api/staging-login/route.ts reads `body.code`. It has never read `accessCode`, and a body
        // carrying only that is an unauthenticated request wearing a plausible field name — so this
        // refuses it exactly as the route does, rather than being lenient and hiding the bug.
        if (!body?.code) return { status: 401, body: { error: "Invalid access code" }, headers: {} };
        if (body.code !== ACCESS_CODE) return { status: 401, body: { error: "Invalid access code" }, headers: {} };
        const email = body?.email;
        if (!tables.app_users.some((u) => u.email === email)) return { status: 403, body: null, headers: {} };
        const cookie = `ps=${email}`;
        sessions.set(cookie, email);
        return { status: 200, body: { ok: true }, headers: { "set-cookie": `${cookie}; Path=/` } };
      }
      // Identity comes from the session cookie alone. Client-supplied identity or role headers are
      // ignored here because the Worker ignores them; a mock that honoured them would let a forged
      // header pass and the gate would never know.
      const email = sessions.get(String(headers.cookie || ""));
      const perms = email ? permissionsFor(email) : [];
      if (method === "GET") {
        if (!perms.includes("bookings.view")) return { status: 403, body: { error: "denied" }, headers: {} };
        return {
          status: 200, headers: {},
          body: { bookings: tables.canonical_bookings.map((b) => ({ ...b, pets: tables.canonical_pets.filter((p) => JSON.parse(b.pet_ids_json).includes(p.id)) })) },
        };
      }
      if (!perms.includes("scheduling.book")) return { status: 403, body: { error: "denied" }, headers: {} };

      const prior = tables.canonical_bookings.find((b) => b.idempotency_key === body.idempotencyKey || b.schedule_group_id === body.scheduleGroupId);
      if (prior) return { status: 200, body: { data: { bookingId: prior.id, duplicatePrevented: true, petIds: JSON.parse(prior.pet_ids_json) } }, headers: {} };

      const link = tables.customer_identity_links.find((l) => l.email === email);
      // faults.ignoreOwnership is the non-vacuity probe for the wrong-owner case: with the rule removed,
      // that request must reach 201. If it cannot, the 403 the gate observes was coming from something
      // else — a missing reservation, a city mismatch — and the check proves nothing about ownership.
      if (!faults.ignoreOwnership && link && link.customer_id !== body.customer.id) return { status: 403, body: { error: "ownership" }, headers: {} };

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

  return { http, d1, tables, httpLog, required, stats: () => ({ maxInFlight }) };
}

const ACCESS_CODE = "x".repeat(32);
const ENV = { EXPECTED_SHA: "b52e7dc1c04efa36d7e89e1b06ad252f9cf5ab6e", ACCESS_CODE, RUN_TAG: "9001-1" };
const silent = () => {};
/** The hosted adapters a correct world supplies: a version marker carrying the sha, and a clean log. */
const okHostedSha = async () => `{"annotations":{"workers/tag":"${ENV.EXPECTED_SHA}"}}`;
const okWorkerLog = async () => '{"outcome":"ok","status":200}';
const run = (world, over = {}) => runGate({
  http: world.http, d1: world.d1, ddl: realDdl, hostedSha: okHostedSha, workerLog: okWorkerLog,
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
// CONSOLIDATION — controls ported from the competing implementation (#204), each with the test that
// fails without it. Nothing below is a restatement: each one caught something.
// ---------------------------------------------------------------------------

// --- A. the login contract ---------------------------------------------------------------------

test("A — the gate signs in with `code`, the field the login route actually reads", async () => {
  const world = makeWorld();
  const bodies = [];
  const spy = { ...world, http: async (m, p, o) => { if (p === "/api/staging-login") bodies.push(o?.body); return world.http(m, p, o); } };
  const report = await run(spy);
  assert.ok(bodies.length >= 3, "the gate must sign in for each role");
  for (const body of bodies) {
    assert.equal(body.code, ACCESS_CODE, "the access code must be sent as `code`");
    assert.ok(!("accessCode" in body), "`accessCode` is not a field the route reads");
  }
  assert.equal(report.failures, 0, `a correct login contract must yield a clean run: ${report.checks.filter((c) => !c.ok).map((c) => c.name).join("; ")}`);
});

test("A — SABOTAGE: posting `accessCode` cannot establish a session, and the gate stops", async () => {
  // This is the competing implementation's contract, driven through this mock. Every sign-in 401s, so
  // the gate must halt at the session harness rather than report the refusals it did not earn.
  const world = makeWorld();
  const wrongField = {
    ...world,
    http: async (m, p, o) => world.http(m, p, p === "/api/staging-login" ? { ...o, body: { accessCode: o?.body?.code, email: o?.body?.email } } : o),
  };
  const report = await run(wrongField);
  assert.equal(report.authHarness, "unavailable", "a gate that cannot sign in must say so");
  assert.ok(failed(report, "real UAT sessions").length === 1);
  assert.ok(!report.checks.some((c) => c.name.includes("GET succeeds with bookings.view")),
    "and it must not go on to claim authorization results");
});

test("A — the mock's refusal matches the real route, not a convenience", () => {
  const route = readFileSync(new URL("../app/api/staging-login/route.ts", import.meta.url), "utf8");
  assert.match(route, /uatAccessCodeValid\(env as never,text\(body\.code\)\)/, "the route reads body.code");
  assert.doesNotMatch(route, /body\.accessCode/, "and never body.accessCode");
});

// --- B. fresh-D1 support schema ----------------------------------------------------------------

test("B — the gate creates every support table from the candidate's own DDL before seeding", async () => {
  const world = makeWorld();
  const created = [];
  const watchDdl = async (table) => { created.push(table); return realDdl(table); };
  const report = await run(world, { ddl: watchDdl });
  assert.deepEqual(created, SUPPORT_TABLES, "all five support tables, in order, before anything is seeded");
  for (const table of SUPPORT_TABLES) {
    assert.ok(world.tables[table], `${table} must exist after the gate created it`);
    assert.ok(world.required[table]?.length > 0, `${table}'s NOT NULL columns must come from the real DDL`);
  }
  assert.equal(report.failures, 0);
});

test("B — SABOTAGE: without the schema step, seeding fails on a fresh database", async () => {
  // Exactly the state of a newly created preview D1: the booking tables the route owns exist, the
  // support tables do not. A gate that assumes them dies at the first seed.
  const world = makeWorld();
  const report = await run(world, { ddl: async () => null });
  assert.equal(report.schema, "unavailable", "the gate must stop, not push on into meaningless refusals");
  assert.ok(report.failures >= SUPPORT_TABLES.length, `every missing table must count as a failure, saw ${report.failures}`);
  assert.ok(report.checks.some((c) => c.unavailable && c.name.includes("app_users")));
});

test("B — the gate carries no schema of its own, so there is nothing to drift", () => {
  const source = readFileSync(new URL("./e2e/release-preview-gate.mjs", import.meta.url), "utf8");
  for (const table of SUPPORT_TABLES) {
    assert.ok(!new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`).test(source),
      `${table}'s DDL must not be copied into the gate — it would drift from the deployed schema`);
  }
  assert.match(source, /ddlFromCheckout\(CANDIDATE_DIR, table\)/, "the CLI must read it from the candidate checkout");
});

test("B — the role insert satisfies every required column, and the incomplete shape is rejected", async () => {
  const ddl = await realDdl("role_definitions");
  assert.ok(ddl, "the product must define role_definitions");
  const needed = requiredColumnsOf(ddl);
  // The real shape, from the real DDL — not a list restated here.
  assert.deepEqual(needed.sort(), ["description", "name", "permissions_json", "updated_at"],
    "these are the columns the deployed database makes mandatory");

  const world = makeWorld();
  await world.d1(ddl);
  // The statement the gate actually uses.
  await world.d1(roleDefinitionInsert("preview_viewer", ["bookings.view"]));
  assert.equal(world.tables.role_definitions.length, 1, "the gate's own insert must be accepted");

  // The competing implementation's shape: code + permissions_json only.
  await assert.rejects(
    () => world.d1(roleDefinitionInsert("preview_thin", ["bookings.view"], ["code", "permissions_json"])),
    /NOT NULL constraint failed: role_definitions\.(name|description|updated_at)/,
    "a role row carrying only code and permissions_json must be rejected, as the real database rejects it",
  );
  assert.equal(world.tables.role_definitions.length, 1, "and nothing may be written");
});

// --- C. authorization additions ----------------------------------------------------------------

test("C — anonymous GET and POST are refused, disclose nothing, and write nothing", async () => {
  const world = makeWorld();
  const report = await run(world);
  for (const name of [
    "an anonymous GET is refused",
    "the anonymous refusal discloses no booking, customer or provider data",
    "an anonymous POST with an otherwise valid payload is refused",
    "the anonymous POST wrote nothing across all five tables",
    "forged identity and role headers cannot manufacture authorization",
    "the forged-header POST wrote nothing across all five tables",
  ]) {
    const found = report.checks.find((c) => c.name === name);
    assert.ok(found, `missing check: ${name}`);
    assert.ok(found.ok, `${name} must pass against a correct world`);
  }
});

test("C — the anonymous POST is non-vacuous: its reservation and payload are otherwise valid", async () => {
  const world = makeWorld();
  await run(world);
  // The group the anonymous POST uses must have a real reservation, or the refusal could have been a
  // 409 for missing scheduling rather than an authorization decision.
  const anonGroups = world.tables.scheduling_reservations.filter((r) => String(r.group_id).endsWith("-anon"));
  assert.equal(anonGroups.length, 1, "a reservation must be seeded for the anonymous attempt");
  // And with a session, that same group and payload succeed — which is what makes the refusal meaningful.
  const withSession = makeWorld();
  const report = await run(withSession);
  assert.ok(report.checks.find((c) => c.name === "POST succeeds with scheduling.book and customer ownership")?.ok);
});

test("C — SABOTAGE: a forged header that is honoured is caught", async () => {
  const world = makeWorld();
  const original = world.http;
  const gullible = {
    ...world,
    http: async (method, path, opts = {}) => {
      const forgedEmail = opts.headers?.["oai-authenticated-user-email"];
      if (forgedEmail && !opts.headers?.cookie) {
        // A Worker that trusted the header would resolve the identity from it.
        return original(method, path, { ...opts, headers: { ...opts.headers, cookie: `ps=${forgedEmail}` } });
      }
      return original(method, path, opts);
    },
  };
  const report = await run(gullible);
  assert.ok(failed(report, "forged identity and role headers").length === 1,
    "an honoured forged header must fail the gate");
});

test("C — the wrong-owner case is non-vacuous: bypassing ownership reaches 201", async () => {
  // With the ownership rule removed the request must SUCCEED. If it still failed, the 403 the gate
  // observes would be coming from something downstream — a missing reservation, a city mismatch — and
  // the check would be proving nothing about ownership at all.
  const report = await run(makeWorld({ ignoreOwnership: true }));
  const owner = report.checks.find((c) => c.name === "POST for a customer this session does not own is refused 403");
  assert.ok(owner, "the wrong-owner check must exist");
  assert.ok(!owner.ok, "with ownership bypassed the gate must fail this check");
  assert.match(owner.detail, /status=201/, `the bypassed request must reach 201, proving no downstream refusal is masking it — saw ${owner.detail}`);
});

test("C — the wrong-owner check demands 403 exactly, not merely 'an error'", () => {
  const source = readFileSync(new URL("./e2e/release-preview-gate.mjs", import.meta.url), "utf8");
  assert.match(source, /wrongOwner\.status === 403/, "a 409 would mean the ownership rule was never reached");
  assert.doesNotMatch(source, /wrongOwner\.status >= 400/, "the loose form cannot distinguish the two");
});

// --- D. unique run namespace -------------------------------------------------------------------

test("D — a run tag is required, and there is no constant fallback", async () => {
  const world = makeWorld();
  await assert.rejects(() => run(world, { env: { ...ENV, RUN_TAG: "" } }), /RUN_TAG is required/,
    "an absent run tag must refuse, not default");
  await assert.rejects(() => run(world, { env: { ...ENV, RUN_TAG: "///" } }), /RUN_TAG is required/,
    "and a tag that sanitizes to nothing is absent");
  assert.equal(sanitizeRunTag("9001/2"), "9001-2");
  assert.equal(sanitizeRunTag("  Run_42 attempt 3 "), "run-42-attempt-3", "sanitized to a safe non-secret slug");
  assert.equal(sanitizeRunTag(undefined), null);
});

test("D — the same candidate sha runs twice in ONE database under two run tags, independently", async () => {
  // Two workflow runs of the same approved sha — or a re-run of one — must not read each other's rows.
  // Sharing a namespace makes the second run's "duplicate prevented" the first run's booking.
  const world = makeWorld();
  const first = await run(world, { env: { ...ENV, RUN_TAG: "9001-1" } });
  const second = await run(world, { env: { ...ENV, RUN_TAG: "9001-2" } });
  assert.equal(first.failures, 0, `first run: ${first.checks.filter((c) => !c.ok).map((c) => c.name).join("; ")}`);
  assert.equal(second.failures, 0, `second run: ${second.checks.filter((c) => !c.ok).map((c) => c.name).join("; ")}`);
  assert.notEqual(first.run, second.run, "the two runs must occupy different namespaces");

  const groups = world.tables.canonical_bookings.map((b) => b.schedule_group_id);
  assert.ok(groups.some((g) => g.includes("-9001-1-")), "the first run's rows must be present");
  assert.ok(groups.some((g) => g.includes("-9001-2-")), "and the second's, alongside them");
  assert.equal(new Set(groups).size, groups.length, "no group may be shared between the runs");
});

test("D — SABOTAGE: a shared namespace makes the second run see the first run's bookings", async () => {
  const world = makeWorld();
  const first = await run(world, { env: { ...ENV, RUN_TAG: "same" } });
  const second = await run(world, { env: { ...ENV, RUN_TAG: "same" } });
  assert.equal(first.failures, 0);
  assert.notEqual(second.failures, 0, "a colliding namespace must not look like a clean second run");
});

// --- F. mandatory evidence ---------------------------------------------------------------------

test("F — an unreadable hosted version marker FAILS the gate", async () => {
  const report = await run(makeWorld(), { hostedSha: async () => null });
  const marker = report.checks.find((c) => c.name.includes("hosted version marker"));
  assert.ok(marker && !marker.ok, "an unreadable marker must fail");
  assert.match(marker.detail, /NOT RUN/, "and be recorded as not run");
  assert.ok(report.unavailable.includes(marker.name));
});

test("F — a hosted marker for a DIFFERENT sha fails the gate", async () => {
  const report = await run(makeWorld(), { hostedSha: async () => "some other build" });
  assert.ok(failed(report, "hosted version marker").length === 1, "deployment drift must fail");
});

test("F — an unreadable providers table FAILS rather than passing as zero", async () => {
  // The competing implementation wrapped this in `.catch(() => 0)`, so a table it could not read
  // reported "no provider became live" — the one claim nobody should take on trust.
  const report = await run(makeWorld({ providersUnreadable: true }));
  const live = report.checks.find((c) => c.name.includes("no provider became live"));
  assert.ok(live && !live.ok, "an unreadable providers table must fail");
  assert.match(live.detail, /NOT RUN/);
});

test("F — an unsampled Worker log FAILS the gate", async () => {
  const report = await run(makeWorld(), { workerLog: async () => null });
  const logCheck = report.checks.find((c) => c.name.includes("Worker log"));
  assert.ok(logCheck && !logCheck.ok, "a log that could not be sampled must fail");
  assert.match(logCheck.detail, /NOT RUN/);
});

test("F — a 5xx or an exception in the Worker log fails the gate", async () => {
  const withError = await run(makeWorld(), { workerLog: async () => '{"outcome":"exception"}' });
  assert.ok(failed(withError, "Worker log").length === 1, "an unhandled exception must fail");
  const with5xx = await run(makeWorld(), { workerLog: async () => '{"status":503}' });
  assert.ok(failed(with5xx, "Worker log").length === 1, "a 5xx must fail");
});

test("F — NO check can be recorded as not run and still leave the gate passing", async () => {
  // The structural guarantee behind the four tests above: `unavailable` always increments failures, and
  // the CLI's exit condition is failures === 0 with no unavailable harness.
  const source = readFileSync(new URL("./e2e/release-preview-gate.mjs", import.meta.url), "utf8");
  const unavailableBody = source.slice(source.indexOf("const unavailable ="), source.indexOf("const runTag ="));
  assert.match(unavailableBody, /ok:\s*false/, "an unavailable check is a failing check");
  assert.match(unavailableBody, /failures\+\+/, "and it must count");
  assert.doesNotMatch(source, /ok:\s*null/, "there is no third, softer outcome");
  assert.match(source, /report\.failures === 0 && report\.authHarness !== "unavailable" && report\.schema !== "unavailable"/,
    "the exit condition must cover both halt paths as well as the failure count");

  // And behaviourally: every unavailability injected above produced a non-zero failure count.
  for (const over of [{ hostedSha: async () => null }, { workerLog: async () => null }, { ddl: async () => null }]) {
    const report = await run(makeWorld(), over);
    assert.notEqual(report.failures, 0, `an unavailable check must fail the gate: ${JSON.stringify(Object.keys(over))}`);
  }
});

// --- regressions that must NOT arrive from the other branch ------------------------------------

test("the sequential swarm, the loose convergence check and the subset snapshot stay out", () => {
  const source = readFileSync(new URL("./e2e/release-preview-gate.mjs", import.meta.url), "utf8");
  assert.match(source, /boundedAll\(/, "the swarm must go through the bounded-concurrency helper");
  assert.doesNotMatch(source, /for \(let i = 0; i < swarmSize/, "a sequential swarm loop must not return");
  assert.match(source, /all 12 string-\\"7\\" bookings returned 201/, "every one of the twelve must be required");
  assert.match(source, /const snapshot = async \(\) => \{[\s\S]*?for \(const table of TOUCHED_TABLES\)/,
    "snapshots must cover all five tables, never a subset");
});

test("the DDL extractor balances parentheses rather than cutting at the first bracket", () => {
  const source = `x CREATE TABLE IF NOT EXISTS t (a TEXT NOT NULL DEFAULT (''), b INTEGER NOT NULL) y`;
  assert.equal(extractDdl(source, "t"), "CREATE TABLE IF NOT EXISTS t (a TEXT NOT NULL DEFAULT (''), b INTEGER NOT NULL)");
  assert.equal(extractDdl(source, "missing"), null);
  // A DEFAULT is not a required column: the database supplies it.
  assert.deepEqual(requiredColumnsOf(extractDdl(source, "t")), ["b"]);
});
