import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PAY_CANONICAL_DB__", "__PAY_CANONICAL_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => {
      const info = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(info.changes || 0) } };
    },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      const out = [];
      for (const item of items) out.push(await item.run());
      return out;
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const START = "2026-11-12T09:00:00.000Z";
const END = "2026-11-12T11:00:00.000Z";

function freshDb(groupId) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const db = makeD1(sqlite);
  globalThis.__PAY_CANONICAL_DB__ = db;
  globalThis.__PAY_CANONICAL_ENV__ = { PAWSPACE_PAYMENT_ENV: "live" };

  sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_assignment_decisions (group_id TEXT PRIMARY KEY,strategy TEXT NOT NULL,shortlist_json TEXT NOT NULL,selected_provider_id TEXT,status TEXT NOT NULL,actor_id TEXT,reason TEXT,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,reason,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(groupId, "balanced", "[]", "PRV-PAY-1", "assigned", "runtime-test", "seeded", Date.now());
  sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(`RES-${groupId}`, groupId, "PRV-PAY-1", "grooming", "blr", "koramangala", "CUS-PAY-1", "[]", START, END, 1, 1, null, "reserved", "{}", Date.now());
  return { sqlite, db };
}

function bookingRequest({ groupId, idempotencyKey, method, mode, status = "captured" }) {
  return new Request("http://localhost/api/canonical-bookings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      idempotencyKey,
      scheduleGroupId: groupId,
      customer: { id: "CUS-PAY-1", name: "Runtime payer", primaryPhone: "+919000000011" },
      pets: [{ sourceId: "PET-PAY-1", name: "Rex", species: "dog", breed: "Labrador" }],
      cityId: "blr",
      zoneId: "koramangala",
      serviceCode: "grooming",
      packageCode: "dog-bath",
      packageName: "Essential Bath",
      scheduledStart: START,
      scheduledEnd: END,
      provider: { id: "PRV-PAY-1", name: "Runtime Groomer", model: "full_time" },
      totalAmount: 1299,
      amountDueNow: 1299,
      payment: { method, mode, status, detail: "runtime payment boundary" },
      pricing: { discount: 0 },
    }),
  });
}

const route = await import("../app/api/canonical-bookings/route.ts");

async function executeCase(index, payment) {
  const groupId = `SG-PAY-${index}`;
  const { sqlite } = freshDb(groupId);
  try {
    const response = await route.POST(bookingRequest({
      groupId,
      idempotencyKey: `idem-pay-${index}`,
      ...payment,
    }));
    const body = await response.json();
    assert.equal(response.status, 201, `booking failed for ${JSON.stringify(payment)}: ${JSON.stringify(body)}`);
    const row = sqlite.prepare("SELECT status,method,mode FROM booking_payments LIMIT 1").get();
    assert.ok(row, "canonical booking must persist a payment row");
    return row;
  } finally {
    sqlite.close();
  }
}

test("LIVE canonical booking demotes client-asserted capture for online and unknown labels", async () => {
  const cases = [
    { method: "upi", mode: "prepaid" },
    { method: "card", mode: "full" },
    { method: "netbanking", mode: "split" },
    { method: "crypto", mode: "deposit" },
    { method: "totally_made_up", mode: "totally_made_up" },
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const row = await executeCase(index, { ...cases[index], status: "captured" });
    assert.equal(row.status, "created", `${cases[index].method}/${cases[index].mode} must await verified capture in LIVE`);
    assert.equal(row.method, cases[index].method);
    assert.equal(row.mode, cases[index].mode);
  }
});

test("LIVE canonical booking preserves a server-authorized offline cash collection", async () => {
  // localhost uses the test preview staff actor, which holds payments.manage. This executes the real
  // server authorization path: the same submitted status is retained only because the method is
  // genuinely offline and the resolved server actor has the required permission.
  const row = await executeCase(99, { method: "cash", mode: "pay_after_service", status: "captured" });
  assert.equal(row.status, "captured");
});

test("LIVE canonical booking leaves non-captured statuses unchanged", async () => {
  const row = await executeCase(100, { method: "upi", mode: "full", status: "failed" });
  assert.equal(row.status, "failed");
});
