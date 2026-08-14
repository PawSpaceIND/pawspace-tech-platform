/**
 * Over-capacity blocking — the reservation capacity floor fails closed at cap+1, never over-commits.
 *
 * host_maya_rohan is a boarding host with capacity 4. Four overlapping single-pet stays fill it; the
 * fifth overlapping reservation must be refused (fail closed). The guard is the atomic conditional INSERT
 * (SUM(capacity_units)+units <= capacity) inside one db.batch transaction, so the sum can never exceed
 * capacity and capacity can never go negative.
 *
 * Driven through the real POST handler over the transactional D1 shim (createD1), on a NON-LOCALHOST host
 * with a real staff identity (no localhost-superuser shortcut).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

installWorkersHooks("__NBCAP_DB__", "__NBCAP_ENV__");

const gov = await import("../lib/provider-capacity-governance.ts");

const HOST = "https://app.pawspace.in";
const STAFF = "ops@pawspace.in";
const PROVIDER = "host_maya_rohan"; // boarding host, capacity 4, blr / blr-east
const IST = 330 * 60_000;
const istInstant = (daysAhead, hour) => { const s = new Date(Date.now() + IST); return new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate() + daysAhead, hour, 0) - IST); };
const START = istInstant(5, 13).toISOString(), END = istInstant(7, 11).toISOString(); // one overlapping 2-night window

async function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const db = createD1(sqlite);
  globalThis.__NBCAP_DB__ = db;
  globalThis.__NBCAP_ENV__ = {};
  // A staff identity (founder = "*") so reserve passes the gateway (scheduling.book) and staff bypasses
  // requireCustomerOwnership — letting one caller reserve for many distinct customers.
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('u-ops',?,'Ops','founder','active',0,0)").run(STAFF);
  // Seed the roster now (marks the per-db seed guard), then make host_maya_rohan the ONLY live boarding
  // host, so the capacity floor is what's under test — not a fallback to a different provider.
  await gov.seedProviderCapacityDefaults(db);
  sqlite.prepare("UPDATE provider_capacity_profiles SET live=0 WHERE services_json LIKE '%boarding%' AND id!=?").run(PROVIDER);
  return { sqlite, db };
}

const reserve = (n) => import("../app/api/uat-scheduling/route.ts").then(m => m.POST(new Request(`${HOST}/api/uat-scheduling`, {
  method: "POST",
  headers: { "oai-authenticated-user-email": STAFF, "content-type": "application/json" },
  body: JSON.stringify({ clientRequestId: `cap-${n}`, customerId: `CUS-${n}`, petIds: ["Bruno"], serviceCode: "boarding", cityId: "blr", zoneId: "blr-east", scheduledStart: START, scheduledEnd: END, preferredProviderId: PROVIDER }),
})));

const nonCancelledUnits = (sqlite) => sqlite.prepare("SELECT COALESCE(SUM(capacity_units),0) s, COUNT(*) c FROM scheduling_reservations WHERE provider_id=? AND status!='cancelled'").get(PROVIDER);

test("four overlapping stays fill capacity 4; the fifth fails closed and never over-commits", async () => {
  const { sqlite } = await freshDb();

  for (let n = 1; n <= 4; n++) {
    const res = await reserve(n);
    const body = await res.json();
    assert.equal(res.status, 200, `reservation ${n} within capacity must succeed: ${JSON.stringify(body)}`);
    assert.equal(body.data.provider.id, PROVIDER);
  }
  const filled = nonCancelledUnits(sqlite);
  assert.equal(filled.c, 4, "capacity is exactly filled by four stays");
  assert.equal(filled.s, 4, "summed capacity units equal the capacity, not more");

  // The fifth overlapping reservation must be refused (fail closed) — not a 5th row.
  const fifth = await reserve(5);
  const fifthBody = await fifth.json();
  assert.notEqual(fifth.status, 200, `the over-capacity reservation must fail closed: ${JSON.stringify(fifthBody)}`);
  assert.ok([409].includes(fifth.status), `expected a 409 conflict, got ${fifth.status}`);

  const after = nonCancelledUnits(sqlite);
  assert.equal(after.c, 4, "no fifth reservation row was written");
  assert.ok(after.s <= 4, "summed capacity units never exceed capacity");
  assert.ok(after.s >= 0, "capacity never goes negative");
});
