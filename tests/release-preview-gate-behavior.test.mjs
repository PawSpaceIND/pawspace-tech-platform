import test from "node:test";
import assert from "node:assert/strict";
import { runGate, boundedAll, TOUCHED_TABLES } from "./e2e/release-preview-gate.mjs";

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
  const tables = Object.fromEntries(TOUCHED_TABLES.map((t) => [t, []]));
  tables.scheduling_assignment_decisions = [];
  tables.scheduling_reservations = [];
  tables.role_definitions = [];
  tables.app_users = [];
  tables.customer_identity_links = [];
  tables.providers = [];
  const sessions = new Map();
  const httpLog = [];
  let inFlight = 0, maxInFlight = 0;

  const permissionsFor = (email) => {
    const user = tables.app_users.find((u) => u.email === email);
    const role = tables.role_definitions.find((r) => r.code === user?.role_code);
    return role ? JSON.parse(role.permissions_json) : [];
  };

  const d1 = async (sql) => {
    const insert = sql.match(/^INSERT OR REPLACE INTO (\w+) \(([^)]*)\) VALUES \((.*)\)$/s);
    if (insert) {
      const [, table, cols, vals] = insert;
      const keys = cols.split(",").map((c) => c.trim());
      const values = vals.match(/'(?:[^']|'')*'|[^,]+/g).map((v) => v.trim().replace(/^'|'$/g, "").replace(/''/g, "'"));
      const row = Object.fromEntries(keys.map((k, i) => [k, values[i]]));
      tables[table] = tables[table] || [];
      const pk = keys[0];
      const existing = tables[table].findIndex((r) => r[pk] === row[pk]);
      if (existing >= 0) tables[table][existing] = row; else tables[table].push(row);
      return [];
    }
    const count = sql.match(/^SELECT COUNT\(\*\) n FROM (\w+)(?: WHERE (.*))?$/s);
    if (count) {
      const [, table, where] = count;
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
      const seen = {};
      for (const p of tables.canonical_pets) if (String(p.source_pet_id).startsWith("swarm-")) seen[p.source_pet_id] = (seen[p.source_pet_id] || 0) + 1;
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
        const email = body?.email;
        if (!tables.app_users.some((u) => u.email === email)) return { status: 403, body: null, headers: {} };
        const cookie = `ps=${email}`;
        sessions.set(cookie, email);
        return { status: 200, body: { ok: true }, headers: { "set-cookie": `${cookie}; Path=/` } };
      }
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
      if (link && link.customer_id !== body.customer.id) return { status: 403, body: { error: "ownership" }, headers: {} };

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

  return { http, d1, tables, httpLog, stats: () => ({ maxInFlight }) };
}

const ENV = { EXPECTED_SHA: "b52e7dc1c04efa36d7e89e1b06ad252f9cf5ab6e", ACCESS_CODE: "x".repeat(32) };
const silent = () => {};
const run = (world, over = {}) => runGate({ http: world.http, d1: world.d1, env: ENV, log: silent, swarmSize: 6, concurrency: 3, ...over });
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
