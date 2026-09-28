import test from "node:test";
import assert from "node:assert/strict";
import { setupJourney, sessionCookie } from "./helpers/grooming-journey-harness.mjs";
import { seedOwnedPet } from "./helpers/saved-pet-fixture.mjs";
import { enterWorkersDbScope } from "./helpers/module-hooks.mjs";
const route = await import("../app/api/uat-scheduling/route.ts");
const { ensureCanonicalBookingCoreTables } = await import("../lib/canonical-booking-core-schema.ts");
const { resolveAssignmentPolicy } = await import("../lib/provider-assignment-policy.ts");
async function world(t) {
  const ctx = await setupJourney(); t.after(() => ctx.close()); enterWorkersDbScope(ctx.db);
  await seedOwnedPet(ctx.db, "CUST-G07", "PET-G07", "Bruno");
  ctx.cookie = await sessionCookie(ctx.db, "customer", "CUST-G07", "customer:CUST-G07");
  await ensureCanonicalBookingCoreTables(ctx.db);
  const day = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  ctx.input = { action: "preview", clientRequestId: crypto.randomUUID(), customerId: "CUST-G07", petIds: ["PET-G07"],
    serviceCode: "grooming", cityId: "blr", zoneId: "blr-east", serviceAddress: "21 Indiranagar Main Road, Bengaluru",
    servicePincode: "560038", scheduledStart: `${day}T05:30:00.000Z`, scheduledEnd: `${day}T07:30:00.000Z` };
  const first = await call(ctx); assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.ok(first.body.data.providers.length >= 2);
  [ctx.regular, ctx.familiar] = first.body.data.providers.map(p => p.id);
  ctx.sqlite.exec("UPDATE provider_capacity_profiles SET quality_score=10");
  ctx.sqlite.prepare("UPDATE provider_capacity_profiles SET quality_score=? WHERE id=?").run(90, ctx.regular);
  ctx.sqlite.prepare("UPDATE provider_capacity_profiles SET quality_score=? WHERE id=?").run(85, ctx.familiar);
  const resolved = await resolveAssignmentPolicy(ctx.db, "grooming", "blr", new Date(ctx.input.scheduledStart));
  ctx.policy = { ...resolved.config, qualityWeight: 1, fullTimeBonus: 0, distanceWeight: 0, residualCapacityWeight: 0, workloadPenalty: 0, repeatProviderBonus: 12 };
  ctx.sqlite.prepare("UPDATE service_policy_configs SET config_json=? WHERE policy_domain='provider_assignment_policy' AND service_code='grooming'").run(JSON.stringify(ctx.policy));
  return ctx;
}
async function call(ctx, changes = {}) {
  enterWorkersDbScope(ctx.db);
  const response = await route.POST(new Request("https://pawspace.test/api/uat-scheduling", { method: "POST",
    headers: { "content-type": "application/json", cookie: ctx.cookie, origin: "https://pawspace.test" },
    body: JSON.stringify({ ...ctx.input, ...changes }) }));
  return { status: response.status, body: await response.json() };
}
function history(ctx, provider = ctx.familiar, changes = {}) {
  const id = crypto.randomUUID(), end = new Date(Date.now() - 86400000).toISOString();
  const row = { id, idempotency_key: id, customer_id: "CUST-G07", pet_ids_json: '["PET-G07"]', source_pet_ids_json: '["PET-G07"]',
    city_id: "blr", zone_id: "blr-east", service_code: "grooming", package_code: "dog-basic", package_name: "Grooming",
    schedule_group_id: id, provider_id: provider, scheduled_start: end, scheduled_end: end, status: "completed",
    total_amount: 1899, created_by: "test", created_at: Date.now(), updated_at: Date.now(), ...changes };
  ctx.sqlite.prepare(`INSERT INTO canonical_bookings (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
}
test("G07 real preview and automatic reservation use the same completed-history bonus", async t => {
  const ctx = await world(t); history(ctx);
  const preview = await call(ctx); assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.data.providers[0].id, ctx.familiar);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations").get().n, 0);
  const reserved = await call(ctx, { action: "reserve", providerSelection: "auto" });
  assert.equal(reserved.status, 200, JSON.stringify(reserved.body)); assert.equal(reserved.body.data.provider.id, ctx.familiar);
  history(ctx, ctx.regular, { scheduled_end: new Date(Date.now() - 3600000).toISOString() });
  const replay = await call(ctx, { action: "reserve", providerSelection: "auto" });
  assert.equal(replay.body.data.provider.id, ctx.familiar, "history changes never alter an already reserved group");
  assert.equal(replay.body.data.duplicatePrevented, true);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations").get().n, 1);
});
for (const kind of ["leave", "closed-roster", "inactive", "different-service", "busy"]) test(`G07 familiar groomer cannot bypass ${kind}`, async t => {
  const ctx = await world(t); history(ctx);
  if (kind === "leave") ctx.sqlite.prepare("INSERT INTO provider_unavailability (id,provider_id,starts_at,ends_at,reason,status,created_by,created_at,updated_at) VALUES (?,?,?,?,'leave','active','test',1,1)").run(crypto.randomUUID(), ctx.familiar, ctx.input.scheduledStart, ctx.input.scheduledEnd);
  if (kind === "closed-roster") ctx.sqlite.prepare("INSERT INTO scheduling_availability (id,provider_id,city_id,zone_id,date,windows_json,source,updated_at) VALUES (?,?,'blr','blr-east',?,'[]','partner_app',1)").run(crypto.randomUUID(), ctx.familiar, ctx.input.scheduledStart.slice(0, 10));
  if (kind === "inactive") ctx.sqlite.prepare("UPDATE provider_capacity_profiles SET status='inactive' WHERE id=?").run(ctx.familiar);
  if (kind === "different-service") ctx.sqlite.prepare("UPDATE provider_capacity_profiles SET services_json='[\"dog_training\"]' WHERE id=?").run(ctx.familiar);
  if (kind === "busy") {
    const held = await call(ctx, { action: "reserve", clientRequestId: crypto.randomUUID(), providerSelection: "specific", preferredProviderId: ctx.familiar });
    assert.equal(held.status, 200, JSON.stringify(held.body));
  }
  const preview = await call(ctx); assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.ok(preview.body.data.providers.length); assert.ok(!preview.body.data.providers.some(p => p.id === ctx.familiar));
  const reserved = await call(ctx, { action: "reserve", providerSelection: "auto" });
  assert.equal(reserved.status, 200, JSON.stringify(reserved.body)); assert.notEqual(reserved.body.data.provider.id, ctx.familiar);
});
test("G07 explicit current provider choice takes precedence over historical affinity", async t => {
  const ctx = await world(t); history(ctx);
  const reserved = await call(ctx, { action: "reserve", providerSelection: "specific", preferredProviderId: ctx.regular });
  assert.equal(reserved.status, 200, JSON.stringify(reserved.body)); assert.equal(reserved.body.data.provider.id, ctx.regular);
});
test("G07 changed customer and pet identifiers cannot read or use another customer's history", async t => {
  const ctx = await world(t); history(ctx);
  for (const change of [{ customerId: "someone-else" }, { petIds: ["someone-elses-pet"] }]) {
    const response = await call(ctx, change); assert.equal(response.status, 403, JSON.stringify(response.body));
  }
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations").get().n, 0);
});
test("G07 a forged repeat-provider field does not influence automatic matching", async t => {
  const ctx = await world(t);
  const preview = await call(ctx, { repeatProviderId: ctx.familiar, repeatProviderBonus: 999 });
  assert.equal(preview.status, 200, JSON.stringify(preview.body)); assert.equal(preview.body.data.providers[0].id, ctx.regular);
  const reserved = await call(ctx, { action: "reserve", providerSelection: "auto", repeatProviderId: ctx.familiar, repeatProviderBonus: 999 });
  assert.equal(reserved.status, 200, JSON.stringify(reserved.body)); assert.equal(reserved.body.data.provider.id, ctx.regular);
});
test("G07 zero repeat bonus disables continuity in both preview and reservation", async t => {
  const ctx = await world(t); history(ctx);
  ctx.sqlite.prepare("UPDATE service_policy_configs SET config_json=? WHERE policy_domain='provider_assignment_policy' AND service_code='grooming'").run(JSON.stringify({ ...ctx.policy, repeatProviderBonus: 0 }));
  const preview = await call(ctx); assert.equal(preview.status, 200, JSON.stringify(preview.body)); assert.equal(preview.body.data.providers[0].id, ctx.regular);
  const reserved = await call(ctx, { action: "reserve", providerSelection: "auto" });
  assert.equal(reserved.status, 200, JSON.stringify(reserved.body)); assert.equal(reserved.body.data.provider.id, ctx.regular);
});
test("G07 a warm history-aware preview remains read-only", async t => {
  const ctx = await world(t); history(ctx); await call(ctx);
  const before = ctx.sqlite.prepare("SELECT total_changes() n").get().n;
  const preview = await call(ctx); assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(ctx.sqlite.prepare("SELECT total_changes() n").get().n, before);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations").get().n, 0);
});
test("G07 continuity is a governed bonus, not unconditional priority over suitability", async t => {
  const ctx = await world(t); history(ctx);
  ctx.sqlite.prepare("UPDATE provider_capacity_profiles SET quality_score=20 WHERE id=?").run(ctx.familiar);
  const preview = await call(ctx); assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.data.providers[0].id, ctx.regular);
});
test("G07 no eligible provider still refuses a reservation instead of forcing history", async t => {
  const ctx = await world(t); history(ctx);
  ctx.sqlite.exec("UPDATE provider_capacity_profiles SET live=0");
  const preview = await call(ctx); assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual(preview.body.data.providers, []);
  const reserved = await call(ctx, { action: "reserve", providerSelection: "auto" });
  assert.equal(reserved.status, 409, JSON.stringify(reserved.body));
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations").get().n, 0);
});
