/*
 * Scheduling reservation ownership, executed rather than positioned.
 *
 * The previous version of this suite asserted its properties by comparing `indexOf` offsets of
 * literal strings inside app/api/uat-scheduling/route.ts - "the ownership check appears before the
 * insert". Ordering IS a real property here and source position is one way to express it, but it is
 * a brittle one: it pinned an entire import line character-for-character, and any reformatting or
 * rename broke the test without the behaviour changing. Worse, it could not distinguish "ownership
 * is checked first" from "ownership is checked first and then ignored".
 *
 * The property that actually matters is behavioural and stronger: an unauthorized caller must be
 * refused AND must leave no trace - no reservation, no assignment decision, no seeded roster. That
 * is what these tests assert, by counting rows after the call.
 *
 * A `customer` holds scheduling.book (lib/platform-security.ts) and is gated purely by ownership,
 * which makes it the right actor to prove the ownership gate rather than the permission gate.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__SCHED_OWN_DB__", "__SCHED_OWN_ENV__");

const ORIGIN = "https://ops.pawspace.test";
const OWNER = "sched.owner@pawspace.in";
const INTRUDER = "sched.intruder@pawspace.in";
const MANAGER = "sched.manager@pawspace.in";
const OWNER_CUSTOMER = "CUS-SCHED-OWNER";

function makeD1(sqlite) {
  const stmt = (sql, args) => ({
    bind: (...b) => stmt(sql, b),
    first: async (col) => { const r = sqlite.prepare(sql).get(...args); return r === undefined ? null : (col ? r[col] : r); },
    run: async () => { const i = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(i.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args), success: true, meta: {} }),
    raw: async () => sqlite.prepare(sql).all(...args).map((r) => Object.values(r)),
  });
  return {
    prepare: (sql) => stmt(sql, []),
    batch: async (list) => { const out = []; for (const s of list) out.push(await s.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

let ctx;
async function world() {
  if (ctx) return ctx;
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__SCHED_OWN_DB__ = db;
  globalThis.__SCHED_OWN_ENV__ = { APP_ENV: "staging", PAWSPACE_SCHEDULING_ENV: "uat" };

  const auth = await import("../lib/server-auth.ts");
  await auth.ensureSecurityTables(db);
  const now = Date.now();
  for (const [id, email, role] of [
    ["USR-SCHED-OWNER", OWNER, "customer"],
    ["USR-SCHED-INTRUDER", INTRUDER, "customer"],
    ["USR-SCHED-MANAGER", MANAGER, "manager"],
  ]) {
    sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
      .run(id, email, email, role, now, now);
  }
  ctx = { sqlite, db, auth, route: await import("../app/api/uat-scheduling/route.ts") };
  return ctx;
}

/* Row counts across every table the reserve path would touch. An unauthorized call must move none
 * of these - that is the ordering property, measured by outcome instead of by source offset. */
function footprint(sqlite) {
  const count = (t) => {
    try { return Number(sqlite.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n); }
    catch { return 0; }   // table not created yet is also "no writes"
  };
  return {
    reservations: count("scheduling_reservations"),
    decisions: count("scheduling_assignment_decisions"),
    providers: count("canonical_providers"),
    capacity: count("provider_capacity_profiles"),
  };
}

const reserve = (email, customerId, clientRequestId) => new Request(`${ORIGIN}/api/uat-scheduling`, {
  method: "POST",
  headers: { "oai-authenticated-user-email": email, "content-type": "application/json", origin: ORIGIN },
  body: JSON.stringify({
    action: "reserve", clientRequestId, customerId,
    petIds: ["PET-1"], serviceCode: "grooming", cityId: "blr", zoneId: "blr-indiranagar",
    scheduledStart: new Date(Date.now() + 5 * 86400000).toISOString(),
    scheduledEnd: new Date(Date.now() + 5 * 86400000 + 3600000).toISOString(),
  }),
});

test("SCHED-OWN-1: a customer cannot reserve against another customer's id", async () => {
  const { route } = await world();
  const response = await route.POST(reserve(INTRUDER, OWNER_CUSTOMER, "REQ-INTRUDER-1"));
  assert.notEqual(response.status, 200,
    "an intruder reserved a slot against another customer's id");
  assert.ok(response.status === 403 || response.status === 401,
    `expected an ownership refusal, got ${response.status}`);
});

test("SCHED-OWN-2: the refusal leaves NO trace - no reservation, decision, roster or capacity write", async () => {
  /* This is the assertion the source-offset version was reaching for, but measured under sabotage it
   * is NOT the catcher: with requireCustomerOwnership removed the request proceeds and then fails
   * further down for an unrelated reason, still writing nothing, so this stays green. SCHED-OWN-1
   * and SCHED-OWN-3 are the tests that detect a missing ownership check. Kept because it pins the
   * no-orphan-writes property itself, which is worth holding even though it is not the tripwire. */
  const { route, sqlite } = await world();
  const before = footprint(sqlite);
  await route.POST(reserve(INTRUDER, OWNER_CUSTOMER, "REQ-INTRUDER-2"));
  const after = footprint(sqlite);
  assert.deepEqual(after, before,
    `an unauthorized reserve wrote to the database: ${JSON.stringify({ before, after })}`);
});

test("SCHED-OWN-3: an unauthorized caller is not told which fields are missing", async () => {
  /* Ownership must be decided before validation, or the refusal becomes an oracle: an attacker
   * learns the shape of a request they are not allowed to make. */
  const { route } = await world();
  const response = await route.POST(new Request(`${ORIGIN}/api/uat-scheduling`, {
    method: "POST",
    headers: { "oai-authenticated-user-email": INTRUDER, "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ action: "reserve", clientRequestId: "REQ-INTRUDER-3", customerId: OWNER_CUSTOMER }),
  }));
  assert.notEqual(response.status, 200);
  assert.doesNotMatch(await response.text(), /Missing scheduling fields/,
    "an unauthorized caller was told which scheduling fields were missing");
});

test("SCHED-OWN-4: requireCustomerOwnership refuses a mismatch with 403, and staff keep their bypass", async () => {
  const { auth, db } = await world();
  const resolve = async (email) => auth.resolveActor(new Request(`${ORIGIN}/x`, {
    headers: { "oai-authenticated-user-email": email },
  }));

  const intruder = await resolve(INTRUDER);
  await assert.rejects(
    () => auth.requireCustomerOwnership(db, intruder, OWNER_CUSTOMER),
    (error) => {
      const status = error instanceof Response ? error.status : error?.status;
      assert.equal(status, 403, `ownership denial used status ${status}, expected 403`);
      return true;
    });

  // Non-vacuity: a manager holds bookings.manage and must NOT be blocked by the same helper,
  // otherwise the refusal above proves only that the helper denies everyone.
  const manager = await resolve(MANAGER);
  await auth.requireCustomerOwnership(db, manager, OWNER_CUSTOMER);
});
