import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { d1 } from "./helpers/execution-harness.mjs";
installWorkersHooks("__G07_HISTORY_DB__");
const { previousCompletedGroomer, groomingHistoryRanking } = await import("../lib/grooming-repeat-history.ts");
const { CANONICAL_BOOKING_CORE_DDL } = await import("../lib/canonical-booking-core-schema.ts");
const asOf = new Date("2026-09-28T10:00:00.000Z");
const context = { customerId: "customer-a", cityId: "blr", petIds: ["pet-a"], serviceCode: "grooming", scheduledStart: "2026-10-03T05:30:00.000Z" };
const policy = { preferredProviderMode: "preference", repeatProviderBonus: 12, qualityWeight: 1, fullTimeBonus: 5, preferredProviderBonus: 20, distanceWeight: .5, residualCapacityWeight: 1, workloadPenalty: 2 };
function world(t, schema = true) {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  if (schema) sqlite.exec(CANONICAL_BOOKING_CORE_DDL[0]);
  return { sqlite, db: d1(sqlite) };
}
function past(w, overrides = {}) {
  const id = crypto.randomUUID();
  const row = { id, idempotency_key: id, customer_id: "customer-a", pet_ids_json: '["pet-a"]', source_pet_ids_json: '["pet-a"]',
    city_id: "blr", zone_id: "blr-east", service_code: "grooming", package_code: "dog-basic", package_name: "Grooming",
    schedule_group_id: id, provider_id: "familiar", scheduled_start: "2026-09-26T05:30:00.000Z", scheduled_end: "2026-09-26T07:30:00.000Z",
    status: "completed", channel: "customer_app", total_amount: 1899, created_by: "test", created_at: 1, updated_at: 1, ...overrides };
  w.sqlite.prepare(`INSERT INTO canonical_bookings (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
}
test("G07 cold and empty histories infer no groomer and create no tables", async t => {
  const w = world(t, false); assert.equal(await previousCompletedGroomer(w.db, context, asOf), undefined);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n, 0);
});
test("G07 only verified past completed service for this customer, city and pets supplies affinity", async t => {
  const w = world(t); past(w);
  for (const change of [{ customer_id: "other" }, { city_id: "maa" }, { service_code: "dog_training" },
    { status: "cancelled" }, { status: "failed" }, { status: "confirmed" }, { status: "in_progress" },
    { scheduled_end: "2030-01-01T00:00:00Z" }, { scheduled_end: "invalid" }, { pet_ids_json: '["pet-b"]' },
    { pet_ids_json: 'broken-json' }, { pet_ids_json: '"pet-a"' }, { pet_ids_json: '{"pet":"pet-a"}' }, { provider_id: "" }]) {
    past(w, { scheduled_end: "2026-09-28T09:00:00Z", provider_id: "must-not-win", ...change });
  }
  assert.equal(await previousCompletedGroomer(w.db, context, asOf), "familiar");
});
test("G07 latest completed visit wins, independent of later edits to an old booking", async t => {
  const w = world(t); past(w, { provider_id: "older", updated_at: 9999 });
  past(w, { provider_id: "latest", scheduled_end: "2026-09-27T07:30:00Z" });
  assert.equal(await previousCompletedGroomer(w.db, context, asOf), "latest");
});
test("G07 multi-pet continuity requires the same provider previously caring for every selected pet", async t => {
  const w = world(t); past(w, { provider_id: "both", pet_ids_json: '["pet-b","pet-a"]' });
  past(w, { provider_id: "one-only", scheduled_end: "2026-09-27T07:30:00Z" });
  assert.equal(await previousCompletedGroomer(w.db, { ...context, petIds: ["pet-a", "pet-b"] }, asOf), "both");
  assert.equal(await previousCompletedGroomer(w.db, { ...context, petIds: ["pet-c"] }, asOf), undefined);
});
test("G07 history is not truncated at a client-side 500-row cap", async t => {
  const w = world(t); past(w);
  for (let i = 0; i < 510; i++) past(w, { pet_ids_json: '["pet-b"]', scheduled_end: "2026-09-27T07:30:00Z", provider_id: "unrelated" });
  assert.equal(await previousCompletedGroomer(w.db, context, asOf), "familiar");
});
test("G07 chronological order uses actual instants, including timezone offsets", async t => {
  const w = world(t); past(w, { provider_id: "earlier", scheduled_end: "2026-09-28T14:30:00+05:30" });
  past(w, { provider_id: "later", scheduled_end: "2026-09-28T09:30:00Z" });
  assert.equal(await previousCompletedGroomer(w.db, context, asOf), "later");
});
test("G07 an unreadable existing history fails rather than inventing a new-customer result", async () => {
  await assert.rejects(previousCompletedGroomer({ prepare() { throw new Error("history unavailable"); } }, context, asOf), /history unavailable/);
});
for (const change of [{ petIds: [] }, { petIds: ["pet-a", "pet-a"] }, { petIds: [null] }, { customerId: "" }, { cityId: "" }])
  test(`G07 invalid history keys are rejected before a query: ${JSON.stringify(change)}`, async () => {
    await assert.rejects(previousCompletedGroomer({ prepare() { assert.fail("invalid input queried history"); } }, { ...context, ...change }, asOf), /Valid customer/);
  });
for (const change of [{ serviceCode: "dog_training" }, { serviceCode: "boarding" }, { providerSelection: "specific" }, { preferredProviderId: "chosen" }])
  test(`G07 never changes another service or explicit choice: ${JSON.stringify(change)}`, async () => {
    assert.deepEqual(await groomingHistoryRanking({ prepare() { assert.fail("explicit choice queried history"); } }, { ...context, ...change }, policy), {});
  });
for (const change of [{ preferredProviderMode: "disabled" }, { repeatProviderBonus: 0 }])
  test(`G07 operator policy can disable history affinity: ${JSON.stringify(change)}`, async () => {
    assert.deepEqual(await groomingHistoryRanking({ prepare() { assert.fail("disabled feature queried history"); } }, context, { ...policy, ...change }), {});
  });
test("G07 the server uses its policy bonus and never a caller-supplied repeat provider", async t => {
  const w = world(t); past(w);
  const ranked = await groomingHistoryRanking(w.db, { ...context, providerSelection: "auto", repeatProviderId: "forged", repeatProviderBonus: 999 }, policy);
  assert.equal(ranked.repeatProviderId, "familiar"); assert.equal(ranked.rankingWeights.repeatProviderBonus, 12);
  assert.equal(ranked.preferredProviderId, undefined); assert.equal(ranked.preferredProviderMode, undefined);
});
