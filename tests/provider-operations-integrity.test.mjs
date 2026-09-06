import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__T2_OPERATIONS_DB__");

const workspace = await import("../lib/provider-workspace.ts");
const capacity = await import("../lib/provider-capacity-governance.ts");
const settlements = await import("../lib/partner-settlement-governance.ts");

const NOW = Date.now();
const START = new Date(NOW + 86_400_000).toISOString();
const END = new Date(NOW + 90_000_000).toISOString();

function makeD1(sqlite) {
  function statement(sql, args = []) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => sqlite.prepare(sql).get(...args) ?? null,
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
      run: async () => {
        const result = sqlite.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    };
  }
  return {
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}

async function operationsStack() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__T2_OPERATIONS_DB__ = db;
  sqlite.exec(`
    CREATE TABLE canonical_bookings (
      id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, city_id TEXT NOT NULL,
      zone_id TEXT NOT NULL, service_code TEXT NOT NULL, package_name TEXT,
      provider_id TEXT, scheduled_start TEXT NOT NULL, scheduled_end TEXT NOT NULL,
      status TEXT NOT NULL, total_amount REAL NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
    );
  `);
  await capacity.ensureProviderCapacityTables(db);
  await workspace.ensureProviderWorkspaceTables(db);
  return { sqlite, db };
}

function seedProvider(sqlite, { id, city = "blr", zone = "blr-uat", service = "grooming", status = "active", live = 1, capacityLimit = 1 }) {
  sqlite.prepare(`INSERT INTO provider_capacity_profiles
    (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,
     travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,
     effective_to,updated_by,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, city, id, "commission", JSON.stringify([service]), JSON.stringify([zone]), live, 4.8, 92,
    capacityLimit, 0, 8, 3, status, 1, "2026-01-01", null, "t2-test", NOW,
  );
}

function seedBooking(sqlite, { id, providerId = null, city = "blr", zone = "blr-uat", service = "grooming", start = START, end = END, status = "scheduled" }) {
  sqlite.prepare(`INSERT INTO canonical_bookings
    (id,customer_id,city_id,zone_id,service_code,package_name,provider_id,scheduled_start,scheduled_end,status,total_amount,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, `CUS-${id}`, city, zone, service, "T2 package", providerId, start, end, status, 1_000, NOW,
  );
}

test("provider offer creation enforces real booking, activation, city, zone, service and capacity", async () => {
  const { sqlite, db } = await operationsStack();
  seedBooking(sqlite, { id: "E2E100-T2-OFFER" });
  seedProvider(sqlite, { id: "valid" });
  seedProvider(sqlite, { id: "wrong-city", city: "mum" });
  seedProvider(sqlite, { id: "wrong-zone", zone: "blr-west" });
  seedProvider(sqlite, { id: "wrong-service", service: "dog_training" });
  seedProvider(sqlite, { id: "inactive", status: "inactive" });
  seedProvider(sqlite, { id: "offline", live: 0 });
  seedProvider(sqlite, { id: "busy" });
  seedBooking(sqlite, { id: "E2E100-T2-OVERLAP", providerId: "busy" });

  await assert.rejects(workspace.offerJobToProvider(db, { providerId: "valid", bookingId: "missing" }), /Booking not found/);
  await assert.rejects(workspace.offerJobToProvider(db, { providerId: "wrong-city", bookingId: "E2E100-T2-OFFER" }), /city/);
  await assert.rejects(workspace.offerJobToProvider(db, { providerId: "wrong-zone", bookingId: "E2E100-T2-OFFER" }), /zone/);
  await assert.rejects(workspace.offerJobToProvider(db, { providerId: "wrong-service", bookingId: "E2E100-T2-OFFER" }), /service/);
  await assert.rejects(workspace.offerJobToProvider(db, { providerId: "inactive", bookingId: "E2E100-T2-OFFER" }), /active/);
  await assert.rejects(workspace.offerJobToProvider(db, { providerId: "offline", bookingId: "E2E100-T2-OFFER" }), /active/);
  await assert.rejects(workspace.offerJobToProvider(db, { providerId: "busy", bookingId: "E2E100-T2-OFFER" }), /capacity/);

  const result = await workspace.offerJobToProvider(db, { providerId: "valid", bookingId: "E2E100-T2-OFFER" });
  assert.equal(result.status, "offered");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_job_offers").get().n, 1);
});

test("all supported provider roles remain isolated across Bangalore, Mumbai, Pune, Hyderabad and Chennai", async () => {
  const { sqlite, db } = await operationsStack();
  const cities = ["blr", "mum", "pune", "hyd", "chn"];
  const services = ["grooming", "dog_training", "boarding", "pet_sitting", "dog_walking", "pet_taxi"];
  for (const city of cities) {
    for (const service of services) seedProvider(sqlite, { id: `${city}-${service}`, city, zone: `${city}-uat`, service });
  }

  for (const city of cities) {
    for (const service of services) {
      const eligible = await capacity.loadGovernedProviders(db, city, `${city}-uat`, service, new Date(NOW));
      assert.deepEqual(eligible.map((provider) => provider.id), [`${city}-${service}`]);
      assert.ok(eligible.every((provider) => provider.cityId === city && provider.services.includes(service)));
    }
  }
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_capacity_profiles WHERE updated_by='t2-test'").get().n, 30);
});

test("expired provider offer cannot assign the booking and becomes expired", async () => {
  const { sqlite, db } = await operationsStack();
  seedBooking(sqlite, { id: "E2E100-T2-EXPIRED" });
  seedProvider(sqlite, { id: "provider-expired" });
  sqlite.prepare("INSERT INTO provider_job_offers (id,provider_id,booking_id,status,offered_at,expires_at) VALUES (?,?,?,?,?,?)")
    .run("OFR-EXPIRED", "provider-expired", "E2E100-T2-EXPIRED", "offered", NOW - 120_000, NOW - 60_000);

  await assert.rejects(
    workspace.respondToJobOffer(db, { providerId: "provider-expired", bookingId: "E2E100-T2-EXPIRED", accept: true }),
    /expired/,
  );
  assert.equal(sqlite.prepare("SELECT status FROM provider_job_offers WHERE id='OFR-EXPIRED'").get().status, "expired");
  assert.equal(sqlite.prepare("SELECT provider_id FROM canonical_bookings WHERE id='E2E100-T2-EXPIRED'").get().provider_id, null);
});

test("an offer cannot report accepted when the canonical booking belongs to another provider", async () => {
  const { sqlite, db } = await operationsStack();
  seedBooking(sqlite, { id: "E2E100-T2-OWNED", providerId: "owner" });
  seedProvider(sqlite, { id: "challenger" });
  sqlite.prepare("INSERT INTO provider_job_offers (id,provider_id,booking_id,status,offered_at) VALUES (?,?,?,?,?)")
    .run("OFR-CHALLENGE", "challenger", "E2E100-T2-OWNED", "offered", NOW);

  await assert.rejects(
    workspace.respondToJobOffer(db, { providerId: "challenger", bookingId: "E2E100-T2-OWNED", accept: true }),
    /already assigned/,
  );
  assert.equal(sqlite.prepare("SELECT provider_id FROM canonical_bookings WHERE id='E2E100-T2-OWNED'").get().provider_id, "owner");
  assert.equal(sqlite.prepare("SELECT status FROM provider_job_offers WHERE id='OFR-CHALLENGE'").get().status, "offered");
});

test("decline is recoverable and a later eligible provider can accept the same canonical booking", async () => {
  const { sqlite, db } = await operationsStack();
  seedBooking(sqlite, { id: "E2E100-T2-RECOVER" });
  seedProvider(sqlite, { id: "provider-declines" });
  seedProvider(sqlite, { id: "provider-recovers" });
  await workspace.offerJobToProvider(db, { providerId: "provider-declines", bookingId: "E2E100-T2-RECOVER" });
  await workspace.offerJobToProvider(db, { providerId: "provider-recovers", bookingId: "E2E100-T2-RECOVER" });
  const declined = await workspace.respondToJobOffer(db, { providerId: "provider-declines", bookingId: "E2E100-T2-RECOVER", accept: false });
  assert.equal(declined.status, "declined");
  assert.equal(sqlite.prepare("SELECT provider_id FROM canonical_bookings WHERE id='E2E100-T2-RECOVER'").get().provider_id, null);
  const accepted = await workspace.respondToJobOffer(db, { providerId: "provider-recovers", bookingId: "E2E100-T2-RECOVER", accept: true });
  assert.equal(accepted.status, "accepted");
  assert.equal(sqlite.prepare("SELECT provider_id FROM canonical_bookings WHERE id='E2E100-T2-RECOVER'").get().provider_id, "provider-recovers");
});

test("failed settlement cannot report approved or emit a false approval event", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  await settlements.ensurePartnerSettlementTables(db);
  sqlite.prepare(`INSERT INTO partner_settlement_statements
    (id,provider_id,period_code,currency,earned_amount,adjustment_amount,payable_amount,status,source_json,
     policy_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "SET-FAILED", "provider-a", "2026-08", "INR", 1_000, 0, 1_000, "failed", "[]", "approved", NOW, NOW,
  );

  await assert.rejects(
    settlements.approveSettlement(db, { statementId: "SET-FAILED", actor: "finance-checker@pawspace.test" }),
    /draft or held/,
  );
  assert.equal(sqlite.prepare("SELECT status FROM partner_settlement_statements WHERE id='SET-FAILED'").get().status, "failed");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM partner_settlement_events WHERE statement_id='SET-FAILED'").get().n, 0);
});

test("approved entitlement produces one exact sandbox instruction and never marks money paid", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  await settlements.ensurePartnerSettlementTables(db);
  sqlite.prepare(`INSERT INTO partner_settlement_statements
    (id,provider_id,period_code,currency,earned_amount,adjustment_amount,payable_amount,status,source_json,
     policy_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "SET-READY", "provider-a", "2026-08", "INR", 1_200, -200, 1_000, "draft", "[]", "approved", NOW, NOW,
  );
  await settlements.approveSettlement(db, { statementId: "SET-READY", actor: "finance-checker@pawspace.test" });
  const first = await settlements.createSandboxPayoutInstruction(db, {
    statementId: "SET-READY", idempotencyKey: "E2E100-T2-PAYOUT", actor: "finance-maker@pawspace.test",
  });
  assert.equal(first.amount, 1_000);
  assert.equal(first.environment, "sandbox");
  assert.equal(first.status, "approval_required");
  assert.equal(first.liveMoney, false);
  const replay = await settlements.createSandboxPayoutInstruction(db, {
    statementId: "SET-READY", idempotencyKey: "E2E100-T2-PAYOUT", actor: "finance-maker@pawspace.test",
  });
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM partner_payout_instructions").get().n, 1);
  assert.equal(sqlite.prepare("SELECT status FROM partner_payout_instructions").get().status, "approval_required");
});
