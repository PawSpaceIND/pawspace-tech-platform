import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setupJourney, routeCall, sessionCookie } from "./helpers/grooming-journey-harness.mjs";

/*
 * insertReservations() commits a group of guarded inserts, then counts how many rows actually landed
 * and rolls its own attempt back if the count is short. Both halves of that used to be keyed on
 * (group_id, created_at):
 *
 *   SELECT COUNT(*) ... WHERE group_id=? AND created_at=?
 *   DELETE          ... WHERE group_id=? AND created_at=?
 *
 * Neither column identifies the REQUEST. group_id is `input.groupId ?? input.clientRequestId`, so on
 * the reassign path it is stable across every request touching that group, and created_at is
 * Date.now(). Two invocations that share a group and land in the same millisecond therefore read and
 * delete each other's rows: one can count the other's committed reservations as its own and report
 * success having inserted nothing, or roll back and delete reservations it never created.
 *
 * Each attempt now stamps its rows with attempt_id = crypto.randomUUID() and scopes both the count
 * and the rollback to it, so a rollback can only ever remove what its own request inserted.
 *
 * WHAT IS PROVEN HERE. The guarded inserts were always sound: a single
 * `INSERT ... SELECT ... WHERE NOT EXISTS` is atomic under the write lock, and it enforces interval
 * overlap plus a travel buffer plus a daily-job cap - an invariant no unique index can express. Only
 * the verify-and-rollback step was mis-keyed.
 *
 * The last test reproduces the interleaving rather than merely describing it, using the harness's
 * beforeBatch hook to commit a competing reservation in the exact window between provider selection
 * and the insert. Two things make that reachable, and both are easy to get wrong:
 *
 *   - it must be a PARTIAL insert. The rollback is guarded by `if(inserted>0)`, so a request that
 *     commits nothing never rolls anything back. An earlier version of that test blocked the only
 *     occurrence, so the branch never ran and it passed against the mis-keyed code - vacuous.
 *   - it must be a RECURRING service. buildOccurrences only honours `occurrences` for dog_walking
 *     and dog_training; grooming is always one occurrence, so no partial insert is possible there.
 *
 * The clock is frozen for that test so created_at is a value the test can forge a collision on -
 * without it, "same millisecond" is a race the test would only sometimes win. All four tests are
 * sabotage-verified: restoring `WHERE group_id=? AND created_at=?` fails the source contract AND
 * the behavioural test, and removing the drift repair fails the drifted-database test with the exact
 * production error.
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
  // This is the property the rollback depends on: an attempt names only its own rows.
  const scoped = ctx.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations WHERE attempt_id=?").get(first[0].attempt_id).n;
  assert.equal(Number(scoped), first.length, "counting by attempt_id returns exactly that attempt's rows");
});

test("verification counts this request's own writes, and rollback cancels only this attempt", () => {
  const route = fs.readFileSync("app/api/uat-scheduling/route.ts", "utf8");

  // Verification is the sum of meta.changes across the statements this request ran, so it cannot
  // read a colliding invocation's rows as its own.
  assert.match(route, /results\.reduce\(\(sum,result\)=>sum\+Number\(result\?\.meta\?\.changes\|\|0\),0\)/);

  // Rollback names the attempt. Keyed on (group_id, created_at) it could cancel reservations a
  // colliding invocation had committed: group_id is `input.groupId ?? input.clientRequestId`, so it
  // is client-supplied and stable across every request touching a group, and created_at is
  // Date.now().
  assert.match(route, /UPDATE scheduling_reservations SET status='cancelled' WHERE attempt_id=\?/);
  assert.doesNotMatch(
    route, /SET status='cancelled' WHERE group_id=\? AND created_at=\?/,
    "rolling back by (group_id, created_at) cancels a colliding request's committed reservations",
  );
  assert.doesNotMatch(
    route, /FROM scheduling_reservations WHERE group_id=\? AND created_at=\?/,
    "and counting by it reads their rows as this request's",
  );

  // The attempt token must be per-request and never derived from anything a caller controls.
  assert.match(route, /attemptId=crypto\.randomUUID\(\)/);
  assert.match(route, /attempt_id TEXT\)/, "the column backing it is declared");
  assert.match(route, /idx_scheduling_reservations_attempt ON scheduling_reservations\(attempt_id\)/, "and indexed");

  // The column must be repaired onto an already-existing table before any statement names it, via
  // the shared repair rather than the route's own ALTER (tests/package-upgrade-schema-drift.test.mjs
  // pins that convention). Without this the route 500s on every scheduling request against any live
  // database, because CREATE TABLE IF NOT EXISTS cannot add a column to a table that already exists.
  assert.match(route, /repairSchemaDrift\(db\)/, "the route must run the shared drift repair");
  assert.ok(
    route.indexOf("repairSchemaDrift(db)") < route.indexOf("idx_scheduling_reservations_attempt"),
    "and must run it BEFORE anything names attempt_id",
  );

  // The database-level backstop from the branch this merged with stays in place.
  assert.match(route, /ON CONFLICT\(provider_id,scheduled_start,scheduled_end\)/, "the exact-slot unique conflict target survives the merge");
});

test("a live database missing attempt_id is repaired in place, not left to fail writes", () => {
  // scheduling_reservations is declared with CREATE TABLE IF NOT EXISTS in more than one module, so a
  // database that already exists never gains the column from the declaration alone.
  const repair = fs.readFileSync("lib/schema-drift-repair.ts", "utf8");
  assert.match(repair, /table: "scheduling_reservations", column: "attempt_id"/);
});

/*
 * The shape every live database is actually in, i.e. the production table before this change:
 * everything the route declares today except attempt_id. scheduling_reservations is declared with
 * CREATE TABLE IF NOT EXISTS in app/api/uat-scheduling, app/api/provider-capacity-control and two
 * runtime workers, so once the table exists the declaration is a no-op and the first writer's shape
 * is the real one forever.
 */
const PRE_ATTEMPT_SHAPE = `CREATE TABLE scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,\
provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,\
customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,\
capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,\
status TEXT NOT NULL,explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,\
lease_expires_at INTEGER,customer_session_id TEXT)`;

test("a database whose scheduling_reservations predates attempt_id is repaired in place, not 500ed", async (t) => {
  const ctx = await setupJourney();
  t.after(ctx.close);

  // Drop the fixture's table and put back the drifted shape. Without this the suite proves nothing:
  // every node:sqlite harness builds the table from the route's OWN declaration, which already has
  // the column, so none of them can see the state a real deploy lands in. That blind spot is why
  // this shipped - only the runtime-D1 regression, which runs against real D1 with the table already
  // created, failed, and it failed with a 500 on every scheduling request:
  //   D1_ERROR: no such column: attempt_id at offset 90: SQLITE_ERROR
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
test("a partial insert rolls back only its own attempt, even when a colliding request shares the group and the millisecond", async (t) => {
  const ctx = await setupJourney();
  t.after(ctx.close);

  // Freeze the clock. The route stamps created_at = Date.now(), so freezing it is what lets this test
  // forge the exact collision the old key was vulnerable to: a DIFFERENT request whose committed row
  // shares BOTH group_id and created_at. Frozen at the real current instant rather than shifted, so
  // lease expiry and booking-window checks behave normally.
  const FIXED = Date.now();
  const realNow = Date.now;
  Date.now = () => FIXED;
  t.after(() => { Date.now = realNow; });

  // dog_walking, not grooming: buildOccurrences only honours `occurrences` for the recurring services
  // (dog_walking, dog_training), and a PARTIAL insert is the only way to reach the rollback at all -
  // the branch is guarded by `if(inserted>0)`, so a request that commits nothing never rolls back.
  const customerId = "CUST-ATTEMPT-RACE";
  const cookie = await sessionCookie(ctx.db, "customer", customerId, `customer:${customerId}`);
  const groupId = "ATTEMPT-RACE-A";
  const first = slot(21), second = slot(28); // cadenceDays 7 puts occurrence 2 exactly a week on

  // Land a competing committed reservation in the window between provider selection and the insert -
  // the TOCTOU gap the guarded insert exists to close. It takes occurrence 2's slot, so this request
  // commits occurrence 1, fails occurrence 2, and must roll its own attempt back.
  //
  // group_id is shared legitimately: it is `input.groupId ?? input.clientRequestId`, so every request
  // touching a group carries the same one, and on the reassign path several do.
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
  // THE DISCRIMINATOR. Keyed on (group_id, created_at) this row matches the rolling-back request on
  // BOTH columns, so the rollback cancels a reservation another request had committed. Keyed on
  // attempt_id it cannot be reached. Sabotage-verified: restoring the old key fails this assertion.
  assert.equal(collider.status, "assigned", "a rollback must not cancel a colliding request's committed reservation");
  assert.equal(collider.attempt_id, "attempt-of-a-different-request", "and must not restamp it");

  const own = ctx.sqlite.prepare("SELECT id,status FROM scheduling_reservations WHERE group_id=? AND id!='RES-COLLIDER'").all(groupId);
  assert.ok(own.length > 0, "the attempt must have committed a row, or the rollback branch was never reached");
  assert.ok(own.every((row) => row.status === "cancelled"), `the attempt's own rows are rolled back: ${JSON.stringify(own)}`);
});
