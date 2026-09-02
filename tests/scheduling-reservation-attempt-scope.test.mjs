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
 * WHAT IS AND IS NOT PROVEN HERE. The guarded inserts were always sound: a single
 * `INSERT ... SELECT ... WHERE NOT EXISTS` is atomic under the write lock, and it enforces interval
 * overlap plus a travel buffer plus a daily-job cap - an invariant no unique index can express. Only
 * the verify-and-rollback step was mis-keyed. Reaching that step's failure needs a row to appear
 * between provider selection and the insert, in the window where the guard's buffered check is
 * stricter than selection's. That is a genuine interleaving, not something this suite can stage
 * synchronously through the route, so the tests below prove the mechanism and pin the key rather
 * than reproducing the interleaving. Recorded plainly so nobody mistakes the contract for a repro.
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

  // The database-level backstop from the branch this merged with stays in place.
  assert.match(route, /ON CONFLICT\(provider_id,scheduled_start,scheduled_end\)/, "the exact-slot unique conflict target survives the merge");
});

test("a live database missing attempt_id is repaired in place, not left to fail writes", () => {
  // scheduling_reservations is declared with CREATE TABLE IF NOT EXISTS in more than one module, so a
  // database that already exists never gains the column from the declaration alone.
  const repair = fs.readFileSync("lib/schema-drift-repair.ts", "utf8");
  assert.match(repair, /table: "scheduling_reservations", column: "attempt_id"/);
});
