import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createCapturedCanonicalSittingQuote } from "./helpers/canonical-sitting-commercial.mjs";

// ---------------------------------------------------------------------------
// PTJA-P1-F33 — a governed refusal was double-encoded, so the customer saw the envelope.
//
// MEASURED against the real POST handler:
//   {"error":"{\"error\":\"Authentication required\"}"}
//   {"error":"{\"error\":\"Sitting care window changed after quote\"}"}
//
// The handler catches a thrown Response and re-wraps error.text() as {error: <text>}. Governance
// modules throw two shapes: lib/sitting-governance.ts throws governedJsonError({error:"..."}) - a JSON
// body - while lib/training-commercial-governance.ts and lib/boarding-governance.ts throw
// new Response("plain sentence"). Reading both as plain text turns the first into a JSON blob in the
// field the UI renders. Same class as PTJA-P1-01: a machine artifact reaching a customer as copy.
// ---------------------------------------------------------------------------
installWorkersHooks("__REFUSAL_ENV_DB__", "__REFUSAL_ENV_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return { prepare: (sql) => statement(sql, []), batch: async (l) => { const o = []; for (const i of l) o.push(await i.run()); return o; }, exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; } };
}

const DDL = [
  "CREATE TABLE IF NOT EXISTS scheduling_assignment_decisions (group_id TEXT PRIMARY KEY,strategy TEXT NOT NULL,shortlist_json TEXT NOT NULL,selected_provider_id TEXT,status TEXT NOT NULL,actor_id TEXT,reason TEXT,updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)",
];
const START = "2026-11-04T04:30:00.000Z", END = "2026-11-04T06:30:00.000Z";
const CUSTOMER = "CUS-REFENV-1", PROVIDER = "PRV-REFENV-1";

async function refuse({ url = "http://localhost/api/canonical-bookings", serviceCode = "pet_sitting", start = START, end = END, withQuote = true, totalOverride = null } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__REFUSAL_ENV_DB__ = makeD1(sqlite);
  globalThis.__REFUSAL_ENV_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox" };
  for (const ddl of DDL) sqlite.exec(ddl);
  const group = "SG-REFENV";
  sqlite.prepare("INSERT OR REPLACE INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,reason,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(group, "balanced", "[]", PROVIDER, "assigned", "t", "s", 1);
  sqlite.prepare("INSERT OR REPLACE INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("R-" + group, group, PROVIDER, serviceCode, "blr", "blr-east", CUSTOMER, "[]", START, END, 1, 1, null, "reserved", "{}", 1);
  let quote = null;
  if (withQuote) ({ quote } = await createCapturedCanonicalSittingQuote(globalThis.__REFUSAL_ENV_DB__, { scheduledStart: START, scheduledEnd: END, cityId: "blr", zoneId: "blr-east", petCount: 1, paymentMode: "prepaid", paymentKey: "refenv" }));
  const { POST } = await import("../app/api/canonical-bookings/route.ts");
  const response = await POST(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    idempotencyKey: "refenv-1", scheduleGroupId: group,
    customer: { id: CUSTOMER, name: "Refusal envelope tester", primaryPhone: "+919000000003" },
    pets: [{ sourceId: "refenv-pet", name: "Bruno", species: "dog" }],
    cityId: "blr", zoneId: "blr-east", serviceCode,
    packageCode: quote?.packageCode ?? "home-visit", packageName: quote?.packageName ?? "Pet Sitting",
    scheduledStart: start, scheduledEnd: end,
    provider: { id: PROVIDER, name: "Provider One", model: "full_time" },
    totalAmount: totalOverride ?? quote?.totalAmount ?? 1349, amountDueNow: totalOverride ?? quote?.amountDueNow ?? 1349,
    payment: { method: "upi", mode: quote?.paymentMode ?? "prepaid", status: "captured", detail: "customer app" },
    pricing: { discount: 0, sittingQuoteId: quote?.quoteId, trainingQuoteId: "TQ-REFENV", boardingQuoteId: "BQ-REFENV" },
  }) }));
  return { status: response.status, body: JSON.parse(await response.clone().text()) };
}

/** The field the UI renders must be a sentence, never a serialised envelope. */
function assertPlainSentence(body, label) {
  assert.equal(typeof body.error, "string", `${label}: error must be a string`);
  assert.doesNotMatch(body.error, /^\s*[{[]/, `${label}: the customer must not be shown a JSON envelope: ${body.error}`);
  assert.doesNotMatch(body.error, /\\"|"error"/, `${label}: nor an escaped one: ${body.error}`);
}

test("P1-E01 a Sitting commercial refusal reaches the customer as a sentence", async () => {
  // A mispriced Sitting booking. Which commercial rule fires first is not the point and is not pinned;
  // what is pinned is that whatever refuses, the customer is shown its sentence.
  const result = await refuse({ totalOverride: 99 });
  assert.equal(result.status, 409);
  assertPlainSentence(result.body, "sitting amount drift");
  assert.match(result.body.error, /Sitting/);
});

test("P1-E02 a JSON-bodied refusal reaches the customer as its sentence, not its envelope", async () => {
  // The authentication refusal is thrown as a JSON-bodied Response - the shape that was double-encoded.
  // Measured on a public host: {"error":"{\"error\":\"Authentication required\"}"}
  const result = await refuse({ url: "https://app.pawspace.in/api/canonical-bookings", withQuote: false });
  assert.equal(result.status, 401);
  assertPlainSentence(result.body, "authentication");
  assert.match(result.body.error, /Authentication required/);
});

// NOT covered here: lib/grooming-policy-governance.ts throws an envelope carrying code/cityId/zoneId
// beside its sentence, and the fix now re-emits those fields at the top level instead of flattening
// them into a string. This harness stops earlier, at "Grooming package is not active for this
// city/zone" (a plain-text throw), so that field preservation is implemented but is NOT pinned by a
// case in this file. Said plainly rather than asserted loosely.
test("P1-E03 a plain-text governance refusal is unchanged", async () => {
  // lib/training-commercial-governance.ts throws new Response("A valid server Training quote is
  // required", {status:409}) — already a sentence. The fix must not disturb it.
  const result = await refuse({ serviceCode: "dog_training", withQuote: false });
  assert.equal(result.status, 409);
  assertPlainSentence(result.body, "training");
  assert.match(result.body.error, /Training/);
});
