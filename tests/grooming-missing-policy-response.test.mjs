import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__MISSING_POLICY_DB__", "__MISSING_POLICY_ENV__");
function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return { prepare: (sql) => statement(sql, []), batch: async (l) => { const o = []; for (const i of l) o.push(await i.run()); return o; }, exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; } };
}

const policy = fs.readFileSync(new URL("../lib/grooming-policy-governance.ts", import.meta.url), "utf8");
const canonical = fs.readFileSync(new URL("../app/api/canonical-bookings/route.ts", import.meta.url), "utf8");

test("missing Grooming city/zone policy fails closed as a governed conflict", () => {
  assert.match(policy, /if\(!row\)throw Response\.json\(\{error:"Grooming is not commercially configured for this city\/zone",code:"grooming_policy_configuration_required",cityId,zoneId:zoneId\?\?null\},\{status:409\}\)/);
  assert.doesNotMatch(policy, /if\(!row\)throw new Error\("No active Grooming commercial policy is configured for this city\/zone"\)/);
});

// This case used to assert the catch clause's exact SOURCE TEXT, so it broke the moment that clause
// was corrected - even though the behaviour it names was preserved and improved. It now drives the
// real handler: a governance module that throws a 409 Response must come back as a 409 with its own
// sentence, never as a 500 and never as a serialised envelope. [PTJA-P1-F33]
test("canonical booking preserves thrown governed response status instead of converting it to 500", async () => {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__MISSING_POLICY_DB__ = makeD1(sqlite);
  globalThis.__MISSING_POLICY_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox" };
  const group = "SG-MISSING-POLICY";
  sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_assignment_decisions (group_id TEXT PRIMARY KEY,strategy TEXT NOT NULL,shortlist_json TEXT NOT NULL,selected_provider_id TEXT,status TEXT NOT NULL,actor_id TEXT,reason TEXT,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,reason,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(group, "balanced", "[]", "PRV-1", "assigned", "t", "s", 1);
  sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("R-" + group, group, "PRV-1", "dog_training", "blr", "blr-east", "CUS-1", "[]", "2026-11-04T04:30:00.000Z", "2026-11-04T06:30:00.000Z", 1, 1, null, "reserved", "{}", 1);

  const { POST } = await import("../app/api/canonical-bookings/route.ts");
  // lib/training-commercial-governance.ts THROWS new Response("A valid server Training quote is
  // required", {status:409}) for an unknown quote id. That status must survive the catch.
  const response = await POST(new Request("http://localhost/api/canonical-bookings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    idempotencyKey: "missing-policy-1", scheduleGroupId: group,
    customer: { id: "CUS-1", name: "Policy tester", primaryPhone: "+919000000004" },
    pets: [{ sourceId: "mp-pet", name: "Bruno", species: "dog" }],
    cityId: "blr", zoneId: "blr-east", serviceCode: "dog_training",
    packageCode: "training-4-puppy", packageName: "Puppy Training Plan",
    scheduledStart: "2026-11-04T04:30:00.000Z", scheduledEnd: "2026-11-04T06:30:00.000Z",
    provider: { id: "PRV-1", name: "Kiran S.", model: "commission" },
    totalAmount: 6000, amountDueNow: 3000,
    payment: { method: "upi", mode: "split", status: "captured", detail: "x" },
    pricing: { discount: 0, trainingQuoteId: "TQ-DOES-NOT-EXIST" },
  }) }));
  const body = JSON.parse(await response.clone().text());
  assert.equal(response.status, 409, `a governed refusal must keep its own status: ${JSON.stringify(body)}`);
  assert.notEqual(response.status, 500, "and must never be converted to a server error");
  assert.equal(typeof body.error, "string");
  assert.doesNotMatch(body.error, /^\s*[{[]/, `the customer must not be shown an envelope: ${body.error}`);
  assert.match(body.error, /Training quote/);
});
