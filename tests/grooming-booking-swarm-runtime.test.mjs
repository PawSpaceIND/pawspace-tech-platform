import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";

installWorkersHooks("__GROOM_SWARM_DB__", "__GROOM_SWARM_ENV__");

const CITIES = [
  { id: "blr", zone: "blr-east", foreignZone: "maa-central", providerPrefix: "groom_" },
  { id: "maa", zone: "maa-central", foreignZone: "blr-east", providerPrefix: "maa_groom_" },
];
const PACKAGE = { code: "dog-basic", name: "Bath & Basic", amount: 1899 };

async function json(response) {
  return { status: response.status, body: await response.json() };
}

function slot(index) {
  const day = String(index + 1).padStart(2, "0");
  return {
    start: `2026-11-${day}T10:00:00.000Z`,
    end: `2026-11-${day}T12:00:00.000Z`,
  };
}

function scheduleBody(city, index, accepted) {
  const window = slot(index);
  const attempt = `${city.id}-${String(index + 1).padStart(2, "0")}`;
  return {
    action: "reserve",
    clientRequestId: `SWARM-GROUP-${attempt}`,
    customerId: `SWARM-CUSTOMER-${attempt}`,
    petIds: [`SWARM-PET-${attempt}`],
    serviceCode: "grooming",
    cityId: city.id,
    zoneId: accepted ? city.zone : city.foreignZone,
    scheduledStart: window.start,
    scheduledEnd: window.end,
  };
}

async function reserve(body) {
  const { POST } = await import("../app/api/uat-scheduling/route.ts");
  return json(await POST(new Request("http://localhost/api/uat-scheduling", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })));
}

function bookingBody(input, scheduled) {
  const provider = scheduled.body.data.provider;
  const attempt = input.clientRequestId.replace("SWARM-GROUP-", "");
  return {
    idempotencyKey: `SWARM-BOOK-${attempt}`,
    scheduleGroupId: input.clientRequestId,
    customer: {
      id: input.customerId,
      name: `Swarm Customer ${attempt}`,
      primaryPhone: `+9198${attempt.replace(/\D/g, "").padStart(8, "0").slice(-8)}`,
    },
    pets: [{ sourceId: input.petIds[0], name: `Milo ${attempt}`, species: "dog", vaccinationStatus: "verified" }],
    cityId: input.cityId,
    zoneId: input.zoneId,
    serviceCode: "grooming",
    packageCode: PACKAGE.code,
    packageName: PACKAGE.name,
    scheduledStart: input.scheduledStart,
    scheduledEnd: input.scheduledEnd,
    provider: { id: provider.id, name: provider.name, model: provider.model },
    totalAmount: PACKAGE.amount,
    amountDueNow: PACKAGE.amount,
    payment: { method: "upi", mode: "prepaid", status: "created", detail: "deterministic swarm sandbox" },
    pricing: { discount: 0 },
  };
}

async function book(body) {
  const { POST } = await import("../app/api/canonical-bookings/route.ts");
  return json(await POST(new Request("http://localhost/api/canonical-bookings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })));
}

async function setup() {
  const harness = freshCountingD1({ maxBoundParams: 100 });
  globalThis.__GROOM_SWARM_DB__ = harness.db;
  // PAWSPACE_SCHEDULING_ENV declared, as every UAT harness must now: /api/uat-scheduling no longer
  // fabricates provider roster unless the runtime says it is a UAT runtime (PTJA W1-F27). This harness
  // books through the real reserve path with no Ops-published availability, so it says so.
  globalThis.__GROOM_SWARM_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_SCHEDULING_ENV: "uat" };

  const { seedProviderCapacityDefaults } = await import("../lib/provider-capacity-governance.ts");
  const { ensureGroomingPolicyTables } = await import("../lib/grooming-policy-governance.ts");
  await seedProviderCapacityDefaults(harness.db);
  await ensureGroomingPolicyTables(harness.db);

  const now = Date.now();
  const providers = [
    ["maa_groom_anbu", "Anbu R.", "full_time", 4.9, 96],
    ["maa_groom_devi", "Devi S.", "commission", 4.8, 93],
    ["maa_groom_kumar", "Kumar P.", "full_time", 4.7, 90],
  ];
  await harness.db.batch(providers.map(([id, name, model, rating, quality]) => harness.db.prepare(
    "INSERT INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES (?,'maa',?,?,?, ?,1,?,?,1,30,5,3,'active',1,'2026-08-01',NULL,'swarm-test',?)",
  ).bind(id, name, model, JSON.stringify(["grooming"]), JSON.stringify(["maa-central"]), rating, quality, now)));
  await harness.db.prepare(
    "INSERT INTO grooming_commercial_policies (id,policy_code,city_id,zone_id,enforcement_mode,cancellation_cutoff_minutes,refund_percent_before_cutoff,refund_percent_after_cutoff,reschedule_cutoff_minutes,reschedule_allowed_after_cutoff,max_reschedules,reschedule_fee_type,reschedule_fee_value,no_show_refund_percent,multi_pet_max,multi_pet_pricing_mode,change_lock_statuses_json,active,version,effective_from,effective_to,updated_by,updated_at) VALUES ('gpolicy_maa_swarm','grooming-default','maa',NULL,'enforce',0,100,100,0,1,2,'none',0,0,4,'catalogue','[\"completed\",\"cancelled\"]',1,1,'2026-08-01',NULL,'swarm-test',?)",
  ).bind(now).run();
  return harness;
}

test("60 governed Grooming attempts persist an exact two-city booking swarm without overlap or cross-city assignment", async () => {
  const { sqlite } = await setup();
  const attempts = CITIES.flatMap((city) => Array.from({ length: 30 }, (_, index) => ({ city, index, accepted: index < 20 })));
  const successes = [];
  const rejections = [];

  for (const attempt of attempts) {
    const input = scheduleBody(attempt.city, attempt.index, attempt.accepted);
    const scheduled = await reserve(input);
    if (!attempt.accepted) {
      assert.equal(scheduled.status, 409, `${input.clientRequestId} must fail closed: ${JSON.stringify(scheduled.body)}`);
      assert.equal(scheduled.body.error, "NO_SCHEDULE_AVAILABLE");
      rejections.push({ input, scheduled });
      continue;
    }

    assert.equal(scheduled.status, 200, `${input.clientRequestId} must reserve: ${JSON.stringify(scheduled.body)}`);
    assert.equal(scheduled.body.data.status, "assigned");
    assert.ok(String(scheduled.body.data.provider.id).startsWith(attempt.city.providerPrefix));
    const created = await book(bookingBody(input, scheduled));
    assert.equal(created.status, 201, `${input.clientRequestId} must book: ${JSON.stringify(created.body)}`);
    assert.equal(created.body.data.duplicatePrevented, false);
    successes.push({ input, scheduled, created, booking: bookingBody(input, scheduled) });
  }

  assert.equal(attempts.length, 60);
  assert.equal(successes.length, 40);
  assert.equal(rejections.length, 20);
  assert.equal(new Set(successes.map((item) => item.created.body.data.bookingId)).size, 40);

  const cityCounts = sqlite.prepare("SELECT city_id,COUNT(*) count FROM canonical_bookings GROUP BY city_id ORDER BY city_id").all()
    .map((row) => ({ city_id: row.city_id, count: row.count }));
  assert.deepEqual(cityCounts, [{ city_id: "blr", count: 20 }, { city_id: "maa", count: 20 }]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM canonical_bookings WHERE service_code='grooming'").get().count, 40);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM scheduling_reservations WHERE status!='cancelled'").get().count, 40);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM scheduling_reservations r JOIN provider_capacity_profiles p ON p.id=r.provider_id WHERE r.city_id!=p.city_id OR instr(p.zones_json, '\"'||r.zone_id||'\"')=0").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM scheduling_reservations a JOIN scheduling_reservations b ON a.id<b.id AND a.provider_id=b.provider_id AND a.status!='cancelled' AND b.status!='cancelled' AND a.scheduled_start<b.scheduled_end AND a.scheduled_end>b.scheduled_start").get().count, 0);

  const rejectedGroups = rejections.map((item) => item.input.clientRequestId);
  assert.equal(rejectedGroups.filter((group) => sqlite.prepare("SELECT 1 FROM scheduling_reservations WHERE group_id=?").get(group)).length, 0);

  const replayed = successes.filter((_, index) => index % 5 === 0);
  assert.equal(replayed.length, 8);
  for (const item of replayed) {
    const scheduleReplay = await reserve(item.input);
    assert.equal(scheduleReplay.status, 200);
    assert.equal(scheduleReplay.body.data.duplicatePrevented, true);
    assert.equal(scheduleReplay.body.data.provider.id, item.scheduled.body.data.provider.id);

    const bookingReplay = await book(item.booking);
    assert.equal(bookingReplay.status, 200);
    assert.equal(bookingReplay.body.data.duplicatePrevented, true);
    assert.equal(bookingReplay.body.data.bookingId, item.created.body.data.bookingId);
  }

  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM canonical_bookings").get().count, 40);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM provider_work_orders").get().count, 40);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM booking_payments").get().count, 40);
});
