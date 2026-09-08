import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { setupJourney, routeCall, sessionCookie } from "./helpers/grooming-journey-harness.mjs";

const customerId = "WALK-RESERVE-CUSTOMER";
function count(sqlite, table) {
  if (!sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) return 0;
  return Number(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
}
async function fixture(t) {
  const ctx = await setupJourney();
  t.after(ctx.close);
  ctx.sqlite.exec(readFileSync(new URL("../app/api/walking-bookings/route.ts", import.meta.url), "utf8").match(/CREATE TABLE IF NOT EXISTS canonical_pets [^"\n]+/)[0]);
  for (const [id, owner, species] of [["OWNED-DOG", customerId, "dog"], ["FOREIGN-DOG", "OTHER-CUSTOMER", "dog"], ["OWNED-CAT", customerId, "cat"]]) {
    ctx.sqlite.prepare("INSERT INTO canonical_pets(id,customer_id,name,species,vaccination_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id, owner, id, species, "verified", Date.now(), Date.now());
  }
  const cookie = await sessionCookie(ctx.db, "customer", customerId, `customer:${customerId}`);
  const start = new Date(Date.now() + 8 * 86400000);
  start.setUTCHours(1, 30, 0, 0);
  const body = {clientRequestId: "WALK-RESERVE-OWNERSHIP", customerId, petIds: ["OWNED-DOG"], serviceCode: "dog_walking", serviceAddress: "42 Test Road, Indiranagar, Bengaluru 560038", servicePincode: "560038", scheduledStart: start.toISOString(), scheduledEnd: new Date(start.getTime() + 30 * 60000).toISOString(), occurrences: 1};
  return {...ctx, cookie, body};
}

test("Walking rejects a foreign dog before holding any provider capacity", async t => {
  const {sqlite, cookie, body} = await fixture(t);
  const result = await routeCall("../../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", {...body, petIds: ["FOREIGN-DOG"]}, cookie);
  assert.equal(result.status, 403, JSON.stringify(result.body));
  for (const table of ["scheduling_reservations", "scheduling_assignment_decisions", "provider_assignment_offers"]) assert.equal(count(sqlite, table), 0, table);
});

test("Walking reserves an owned saved dog and preserves the same reservation on retry", async t => {
  const {sqlite, cookie, body} = await fixture(t);
  const first = await routeCall("../../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", body, cookie);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.data.status, "assigned");
  const retry = await routeCall("../../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", body, cookie);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.data.duplicatePrevented, true);
  assert.equal(count(sqlite, "scheduling_reservations"), 1);
  assert.deepEqual(JSON.parse(sqlite.prepare("SELECT pet_ids_json FROM scheduling_reservations").get().pet_ids_json), ["OWNED-DOG"]);
});

for (const [label, petIds, expectedStatus] of [
  ["missing dog", ["MISSING-DOG"], 403],
  ["cat", ["OWNED-CAT"], 400],
  ["multiple dogs", ["OWNED-DOG", "FOREIGN-DOG"], 400],
  ["duplicate dog", ["OWNED-DOG", "OWNED-DOG"], 400],
  ["scalar pet IDs", "OWNED-DOG", 400],
  ["non-string pet ID", [42], 400],
]) test(`Walking rejects ${label} without reserving or dispatching`, async t => {
  const {sqlite, cookie, body} = await fixture(t);
  const result = await routeCall("../../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", {...body, petIds}, cookie);
  assert.equal(result.status, expectedStatus, JSON.stringify(result.body));
  for (const table of ["scheduling_reservations", "scheduling_assignment_decisions", "provider_assignment_offers"]) assert.equal(count(sqlite, table), 0, table);
});

test("Walking cannot replay an existing reservation after changing to a foreign dog", async t => {
  const {sqlite, cookie, body} = await fixture(t);
  const first = await routeCall("../../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", body, cookie);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const before = sqlite.prepare("SELECT * FROM scheduling_reservations").all();
  const rejected = await routeCall("../../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", {...body, petIds: ["FOREIGN-DOG"]}, cookie);
  assert.equal(rejected.status, 403, JSON.stringify(rejected.body));
  assert.deepEqual(sqlite.prepare("SELECT * FROM scheduling_reservations").all(), before);
  assert.equal(count(sqlite, "scheduling_assignment_decisions"), 1);
  assert.equal(count(sqlite, "provider_assignment_offers"), 1);
});

test("a second customer cannot replay another customer's scheduling group with their own dog", async t => {
  const {db, sqlite, cookie, body} = await fixture(t);
  const first = await routeCall("../../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", body, cookie);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const secondCookie = await sessionCookie(db, "customer", "OTHER-CUSTOMER", "customer:OTHER-CUSTOMER");
  const before = sqlite.prepare("SELECT * FROM scheduling_reservations").all();
  const rejected = await routeCall("../../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", {...body, customerId: "OTHER-CUSTOMER", petIds: ["FOREIGN-DOG"]}, secondCookie);
  assert.equal(rejected.status, 403, JSON.stringify(rejected.body));
  assert.equal(rejected.body.data, undefined, "no assignment details are returned to the other customer");
  assert.deepEqual(sqlite.prepare("SELECT * FROM scheduling_reservations").all(), before);
});

test("a competing customer that commits during dispatch is not exposed by the collision fallback", async t => {
  const {db, sqlite, cookie, body} = await fixture(t);
  const otherCookie = await sessionCookie(db, "customer", "OTHER-CUSTOMER", "customer:OTHER-CUSTOMER");
  let competitor;
  db.beforeBatch = async statements => {
    if (!statements.some(statement => statement._sql.includes("INSERT INTO scheduling_reservations"))) return;
    db.beforeBatch = null;
    competitor = await routeCall("../../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", {...body, customerId: "OTHER-CUSTOMER", petIds: ["FOREIGN-DOG"]}, otherCookie);
    assert.equal(competitor.status, 200, JSON.stringify(competitor.body));
  };
  const loser = await routeCall("../../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", body, cookie);
  assert.ok(competitor, "the second customer must commit inside the dispatch window");
  assert.equal(loser.status, 403, JSON.stringify(loser.body));
  assert.equal(loser.body.data, undefined);
  assert.deepEqual(sqlite.prepare("SELECT customer_id FROM scheduling_reservations").all().map(row => row.customer_id), ["OTHER-CUSTOMER"]);
  assert.equal(count(sqlite, "scheduling_assignment_decisions"), 1);
  assert.equal(count(sqlite, "provider_assignment_offers"), 1);
});
