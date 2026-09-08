import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setupJourney, routeCall, sessionCookie } from "./helpers/grooming-journey-harness.mjs";

/*
 * Reservation attempts are identified by a random attempt_id. The current dispatcher places every
 * guarded reservation insert plus a CHECK-backed assertion in one D1 batch. If even one occurrence
 * loses a slot race, the assertion fails and D1 rolls the whole request back atomically; there are no
 * partial rows to clean up afterwards and a colliding request's committed rows remain untouched.
 */

const rows = (sqlite, groupId) =>
  sqlite.prepare("SELECT id,attempt_id FROM scheduling_reservations WHERE group_id=? ORDER BY occurrence_number").all(groupId);

function slot(daysAhead) {
  const start = new Date(Date.now() + daysAhead * 86_400_000);
  start.setUTCHours(5, 30, 0, 0);
  return { scheduledStart: start.toISOString(), scheduledEnd: new Date(start.getTime() + 2 * 60 * 60_000).toISOString() };
}

test("every committed reservation carries the attempt that inserted it, and separate attempts differ", async (t) => {
  const ctx = await setupJourney();
  t.after(ctx.close);
  const customerId = "CUST-ATTEMPT-SCOPE";
  const cookie = await sessionCookie(ctx.db, "customer", customerId, `customer:${customerId}`);

  const reserve = async (clientRequestId, daysAhead) => {
    const response = await routeCall("../../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", {
      clientRequestId, customerId, petIds: ["PET-ATTEMPT"], serviceCode: "grooming",
      cityId: "blr", zoneId: "blr-east", ...slot(daysAhead), preferredProviderId: "groom_arun",
    }, cookie);
    assert.equal(response.status, 200, `reserve ${clientRequestId} should succeed: ${JSON.stringify(response.body)}`);
    return rows(ctx.sqlite, clientRequestId);
  };

  const first = await reserve("ATTEMPT-SCOPE-A", 9);
  const second = await reserve("ATTEMPT-SCOPE-B", 11);

  assert.ok(first.length > 0 && second.length > 0, "both reserves must leave rows");
  assert.ok(first.every((r) => r.attempt_id), "an attempt id is stamped, not left null");
  assert.ok(second.every((r) => r.attempt_id));
  assert.equal(new Set(first.map((r) => r.attempt_id)).size, 1, "one attempt stamps its whole group consistently");
  assert.notEqual(first[0].attempt_id, second[0].attempt_id, "a separate request is a separate attempt");
  const scoped = ctx.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations WHERE attempt_id=?").get(first[0].attempt_id).n;
  assert.equal(Number(scoped), first.length, "counting by attempt_id returns exactly that attempt's rows");
});

test("verification and rollback are one atomic dispatch transaction", () => {
  const route = fs.readFileSync("app/api/uat-scheduling/route.ts", "utf8");

  assert.match(route, /scheduling_dispatch_assertions/);
  assert.match(route, /COUNT\(\*\) FROM scheduling_reservations WHERE attempt_id=\? AND status='assigned'/);
  assert.match(route, /try\{await db\.batch\(statements\);\}/, "reservation rows and the completeness assertion commit in one D1 batch");
  assert.doesNotMatch(route, /SET status='cancelled' WHERE group_id=\? AND created_at=\?/,
    "a failed request must never clean up by a caller-controlled group/timestamp pair");
  assert.doesNotMatch(route, /FROM scheduling_reservations WHERE group_id=\? AND created_at=\?/,
    "verification must never count a colliding request's rows as this request's");

  const dispatchStart = route.indexOf("async function commitAssignmentDispatch");
  const dispatchEnd = route.indexOf("async function operateAssignment");
  const dispatch = route.slice(dispatchStart, dispatchEnd);
  assert.ok(dispatchStart >= 0 && dispatchEnd > dispatchStart);
  assert.doesNotMatch(dispatch, /UPDATE scheduling_reservations SET status='cancelled' WHERE attempt_id=\?/,
    "transaction rollback leaves no partial rows, so no post-failure cancellation pass is needed");

  assert.match(route, /attemptId=crypto\.randomUUID\(\)/);
  assert.match(route, /attempt_id TEXT\)/, "the column backing it is declared");
  assert.match(route, /idx_scheduling_reservations_attempt ON scheduling_reservations\(attempt_id\)/, "and indexed");
  assert.match(route, /repairSchemaDrift\(db\)/, "the route must run the shared drift repair");
  assert.ok(route.indexOf("repairSchemaDrift(db)") < route.indexOf("idx_scheduling_reservations_attempt"),
    "and must run it BEFORE anything names attempt_id");
  assert.match(route, /ON CONFLICT\(provider_id,scheduled_start,scheduled_end\)/, "the exact-slot unique conflict target survives the merge");
});

test("a live database missing attempt_id is repaired in place, not left to fail writes", () => {
  const repair = fs.readFileSync("lib/schema-drift-repair.ts", "utf8");
  assert.match(repair, /table: "scheduling_reservations", column: "attempt_id"/);
});

const PRE_ATTEMPT_SHAPE = `CREATE TABLE scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,\
provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,\
customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,\
capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,\
status TEXT NOT NULL,explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,\
lease_expires_at INTEGER,customer_session_id TEXT)`;

test("a database whose scheduling_reservations predates attempt_id is repaired in place, not 500ed", async (t) => {
  const ctx = await setupJourney();
  t.after(ctx.close);
  ctx.sqlite.exec("DROP TABLE IF EXISTS scheduling_reservations");
  ctx.sqlite.exec(PRE_ATTEMPT_SHAPE);
  const columns = () => ctx.sqlite.prepare("PRAGMA table_info(scheduling_reservations)").all().map((row) => row.name);
  assert.ok(!columns().includes("attempt_id"), "the fixture must start drifted or this test is vacuous");

  const customerId = "CUST-ATTEMPT-DRIFT";
  const cookie = await sessionCookie(ctx.db, "customer", customerId, `customer:${customerId}`);
  const response = await routeCall("../../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", {
    clientRequestId: "ATTEMPT-DRIFT-A", customerId, petIds: ["PET-ATTEMPT-DRIFT"], serviceCode: "grooming",
    cityId: "blr", zoneId: "blr-east", ...slot(13), preferredProviderId: "groom_arun",
  }, cookie);

  assert.equal(response.status, 200, `a drifted live table must not fail the reserve: ${JSON.stringify(response.body)}`);
  assert.ok(columns().includes("attempt_id"), "the shared repair added the column in place");
  const stamped = rows(ctx.sqlite, "ATTEMPT-DRIFT-A");
  assert.ok(stamped.length > 0 && stamped.every((row) => row.attempt_id), "and the reserve stamped it");
});

test("a partial insert rolls back atomically without touching a colliding request", async (t) => {
  const ctx = await setupJourney();
  t.after(ctx.close);

  const FIXED = Date.now();
  const realNow = Date.now;
  Date.now = () => FIXED;
  t.after(() => { Date.now = realNow; });

  const customerId = "CUST-ATTEMPT-RACE";
  const cookie = await sessionCookie(ctx.db, "customer", customerId, `customer:${customerId}`);
  const groupId = "ATTEMPT-RACE-A";
  const first = slot(21), second = slot(28);

  let injected = false;
  ctx.db.beforeBatch = async (items) => {
    if (!items.some((item) => String(item._sql).includes("INSERT INTO scheduling_reservations"))) return;
    ctx.db.beforeBatch = null;
    injected = true;
    ctx.sqlite.prepare(
      "INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id," +
      "pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status," +
      "explanation_json,created_at,attempt_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      "RES-COLLIDER", groupId, "walk_asha", "dog_walking", "blr", "blr-east", "CUS-OTHER", "[]",
      second.scheduledStart, second.scheduledEnd, 1, 9, null, "assigned", "{}",
      FIXED, "attempt-of-a-different-request",
    );
  };

  const response = await routeCall("../../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", {
    clientRequestId: groupId, customerId, petIds: ["PET-ATTEMPT-RACE"], serviceCode: "dog_walking",
    cityId: "blr", zoneId: "blr-east", ...first, preferredProviderId: "walk_asha",
    occurrences: 2, cadenceDays: 7,
  }, cookie);

  assert.equal(injected, true, "the competing reservation must land inside the insert window or this test proves nothing");
  assert.equal(response.status, 409, `a partial insert must be refused: ${JSON.stringify(response.body)}`);

  const collider = ctx.sqlite.prepare("SELECT status,attempt_id FROM scheduling_reservations WHERE id='RES-COLLIDER'").get();
  assert.equal(collider.status, "assigned", "transaction rollback must not touch a colliding request's committed reservation");
  assert.equal(collider.attempt_id, "attempt-of-a-different-request", "and must not restamp it");

  const own = ctx.sqlite.prepare("SELECT id,status FROM scheduling_reservations WHERE group_id=? AND id!='RES-COLLIDER'").all(groupId);
  assert.equal(own.length, 0, `the failed dispatch transaction must leave zero partial reservation rows: ${JSON.stringify(own)}`);
});