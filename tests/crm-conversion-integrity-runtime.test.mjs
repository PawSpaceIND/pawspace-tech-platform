import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// ---------------------------------------------------------------------------
// CRM conversion integrity — EXECUTABLE closure.
//
// tests/lead-engine-hardening.test.mjs already executes assignment, SLA and
// callback. What had no executable coverage was the far end of the funnel: what
// a conversion means once the booking behind it changes, and whether a rep is
// credited for it. Executing that path found:
//
//   C1  sales productivity credited a rep with a conversion by joining
//       canonical_bookings to lead_work_items.converted_booking_id with no
//       filter on booking status, so a CANCELLED or REFUNDED booking still
//       counted as that rep's conversion — in both the count metric and the
//       drilldown evidence. revenue-mission-command-center already excludes
//       cancelled revenue, so the two disagreed about the same booking.
// ---------------------------------------------------------------------------

const WORKERS_SHIM = `export const env = new Proxy({}, { get: (_, key) => globalThis.__PAWSPACE_TEST_ENV?.[key] });`;
const workersUrl = `data:text/javascript,${encodeURIComponent(WORKERS_SHIM)}`;
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `const workersUrl=${JSON.stringify(workersUrl)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); },
  };
}

const DAY = 86_400_000;
const NOW = 1770000000000;
const PERIOD_START = NOW - 30 * DAY;
const PERIOD_END = NOW + DAY;
const iso = (ms) => new Date(ms).toISOString();

const CANONICAL_BOOKINGS = "CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',total_amount REAL NOT NULL DEFAULT 0,currency TEXT NOT NULL DEFAULT 'INR',created_at INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0)";
const BOOKING_PAYMENTS = "CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL)";

let seq = 0;
async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db };
  sqlite.exec(CANONICAL_BOOKINGS);
  sqlite.exec(BOOKING_PAYMENTS);
  const conversion = await import("../lib/lead-conversion-attribution.ts");
  const assignment = await import("../lib/lead-assignment-governance.ts");
  const productivity = await import("../lib/sales-productivity-governance.ts");
  const sla = await import("../lib/lead-sla-governance.ts");
  const mission = await import("../lib/revenue-mission-control.ts");
  await conversion.ensureLeadWorkItemsTable(db);
  await assignment.ensureLeadAssignmentTables(db);
  await productivity.ensureSalesProductivityTables(db);
  // the productivity drilldown reads the SLA action log and the revenue event log, both owned
  // elsewhere; create them through their real owners rather than hand-rolling the DDL here.
  await sla.ensureLeadSlaTables(db);
  await mission.ensureRevenueMissionTables(db);
  return { sqlite, db, conversion, assignment, productivity };
}

function seedBooking(sqlite, { id, customerId, status = "confirmed", createdAt = NOW - DAY, city = "blr", amount = 1499 }) {
  seq += 1;
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,total_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, `idem-${id}-${seq}`, customerId, city, `${city}-east`, "grooming", "grooming-basic", "Grooming basic", `grp-${id}-${seq}`, "PROV-1", iso(createdAt), iso(createdAt + 3600000), status, amount, createdAt, createdAt);
}
function seedCapturedPayment(sqlite, bookingId, customerId, status = "captured") {
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,status,created_at) VALUES (?,?,?,?,?,?)")
    .run(`PAY-${bookingId}`, bookingId, customerId, 1499, status, NOW - DAY);
}
function seedLead(sqlite, { id, customerId, initiatedBookingId = null, status = "active", city = "blr" }) {
  const columns = sqlite.prepare("PRAGMA table_info(lead_work_items)").all().map((c) => c.name);
  const row = { id, customer_id: customerId, source: "Website", service: "grooming", owner: "Unassigned", manager: "Sales Manager", status, stage: "day_1", work_day: 1, assigned_at: NOW - 10 * DAY, first_action_due_at: NOW - 10 * DAY + 600000, manager_alert_at: NOW - 10 * DAY + 1800000, call_attempts: 0, whatsapp_attempts: 0, recycle_cycle: 0, opt_out: 0, created_at: NOW - 10 * DAY, updated_at: NOW - 10 * DAY, initiated_booking_id: initiatedBookingId, city_id: city };
  const use = Object.keys(row).filter((k) => columns.includes(k));
  sqlite.prepare(`INSERT INTO lead_work_items (${use.join(",")}) VALUES (${use.map(() => "?").join(",")})`).run(...use.map((k) => row[k]));
}
function seedAssignment(sqlite, { id, leadId, email, teamCode = "sales_blr", assignedAt = NOW - 10 * DAY, endedAt = null }) {
  const columns = sqlite.prepare("PRAGMA table_info(lead_assignments)").all().map((c) => c.name);
  const row = { id, idempotency_key: `assign-${id}`, lead_id: leadId, employee_email: email, team_code: teamCode, policy_id: "POL-1", policy_version: 1, assignment_reason: "new_lead", status: "current", assigned_at: assignedAt, ended_at: endedAt, detail_json: "{}", created_by: "system", created_at: assignedAt };
  const use = Object.keys(row).filter((k) => columns.includes(k));
  sqlite.prepare(`INSERT INTO lead_assignments (${use.join(",")}) VALUES (${use.map(() => "?").join(",")})`).run(...use.map((k) => row[k]));
}
const leadRow = (sqlite, id) => sqlite.prepare("SELECT * FROM lead_work_items WHERE id=?").get(id);

// --- conversion attribution ----------------------------------------------

test("a captured payment converts the lead the booking was actually attributed to", async () => {
  const { sqlite, db, conversion } = await world();
  seedBooking(sqlite, { id: "BK-1", customerId: "CU-1" });
  seedCapturedPayment(sqlite, "BK-1", "CU-1");
  seedLead(sqlite, { id: "LEAD-OTHER", customerId: "CU-1" });
  seedLead(sqlite, { id: "LEAD-SOURCE", customerId: "CU-1", initiatedBookingId: "BK-1" });
  const result = await conversion.convertLeadOnPaymentCaptured(db, { customerId: "CU-1", bookingId: "BK-1" });
  assert.equal(result.leadId, "LEAD-SOURCE", "credit goes to the lead the booking came from, not the newest lead");
  assert.equal(leadRow(sqlite, "LEAD-SOURCE").status, "converted");
  assert.equal(leadRow(sqlite, "LEAD-OTHER").status, "active", "an unrelated open lead is untouched");
});

test("a converted lead is never converted a second time", async () => {
  const { sqlite, db, conversion } = await world();
  seedBooking(sqlite, { id: "BK-2", customerId: "CU-2" });
  seedBooking(sqlite, { id: "BK-2b", customerId: "CU-2" });
  seedLead(sqlite, { id: "LEAD-2", customerId: "CU-2", initiatedBookingId: "BK-2" });
  const first = await conversion.convertLeadOnPaymentCaptured(db, { customerId: "CU-2", bookingId: "BK-2" });
  assert.equal(first.leadId, "LEAD-2");
  const second = await conversion.convertLeadOnPaymentCaptured(db, { customerId: "CU-2", bookingId: "BK-2b" });
  assert.equal(second, null, "there is no open lead left to convert");
  assert.equal(leadRow(sqlite, "LEAD-2").converted_booking_id, "BK-2", "the original attribution is not overwritten");
});

test("replaying the same conversion is idempotent", async () => {
  const { sqlite, db, conversion } = await world();
  seedBooking(sqlite, { id: "BK-3", customerId: "CU-3" });
  seedLead(sqlite, { id: "LEAD-3", customerId: "CU-3", initiatedBookingId: "BK-3" });
  await conversion.convertLeadOnPaymentCaptured(db, { customerId: "CU-3", bookingId: "BK-3" });
  const replay = await conversion.convertLeadOnPaymentCaptured(db, { customerId: "CU-3", bookingId: "BK-3" });
  assert.equal(replay, null);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM lead_work_items WHERE status='converted'").get().c, 1);
});

test("a closed lead is not resurrected by a later payment", async () => {
  const { sqlite, db, conversion } = await world();
  seedBooking(sqlite, { id: "BK-4", customerId: "CU-4" });
  seedLead(sqlite, { id: "LEAD-4", customerId: "CU-4", status: "closed" });
  const result = await conversion.convertLeadOnPaymentCaptured(db, { customerId: "CU-4", bookingId: "BK-4" });
  assert.equal(result, null);
  assert.equal(leadRow(sqlite, "LEAD-4").status, "closed");
});

test("a payment for a customer with no open lead converts nothing", async () => {
  const { db, conversion } = await world();
  const result = await conversion.convertLeadOnPaymentCaptured(db, { customerId: "CU-NOBODY", bookingId: "BK-NONE" });
  assert.equal(result, null);
});

test("one customer's payment never converts another customer's lead", async () => {
  const { sqlite, db, conversion } = await world();
  seedBooking(sqlite, { id: "BK-5", customerId: "CU-5" });
  seedLead(sqlite, { id: "LEAD-OTHERCUST", customerId: "CU-OTHER" });
  const result = await conversion.convertLeadOnPaymentCaptured(db, { customerId: "CU-5", bookingId: "BK-5" });
  assert.equal(result, null, "ownership boundary holds across customers");
  assert.equal(leadRow(sqlite, "LEAD-OTHERCUST").status, "active");
});

// --- C1: a conversion must not survive the booking behind it -------------

async function creditWorld(bookingStatus) {
  const { sqlite, db, conversion, productivity } = await world();
  seedBooking(sqlite, { id: "BK-C", customerId: "CU-C", status: "confirmed", createdAt: NOW - 2 * DAY });
  seedLead(sqlite, { id: "LEAD-C", customerId: "CU-C", initiatedBookingId: "BK-C" });
  seedAssignment(sqlite, { id: "ASSIGN-C", leadId: "LEAD-C", email: "rep.one@pawspace.in" });
  await conversion.convertLeadOnPaymentCaptured(db, { customerId: "CU-C", bookingId: "BK-C" });
  // the booking's life continues after the conversion was credited
  sqlite.prepare("UPDATE canonical_bookings SET status=? WHERE id='BK-C'").run(bookingStatus);
  const drilldown = await productivity.salesProductivityDrilldown(db, { employeeEmail: "rep.one@pawspace.in", periodStart: PERIOD_START, periodEnd: PERIOD_END });
  return { sqlite, drilldown };
}

test("C1: a live booking is credited to the rep who converted the lead", async () => {
  const { drilldown } = await creditWorld("confirmed");
  assert.equal(drilldown.conversions.length, 1, "a real conversion must still be credited");
  assert.equal(drilldown.conversions[0].booking_id, "BK-C");
});

test("C1 regression: a CANCELLED booking is no longer credited as a conversion", async () => {
  const { drilldown } = await creditWorld("cancelled");
  assert.equal(drilldown.conversions.length, 0, "a cancelled booking must not remain an active conversion");
});

test("C1 regression: a REFUNDED booking is no longer credited as a conversion", async () => {
  const { drilldown } = await creditWorld("refunded");
  assert.equal(drilldown.conversions.length, 0, "a refunded booking must not remain an active conversion");
});

test("C1: a completed booking is still a genuine conversion", async () => {
  const { drilldown } = await creditWorld("completed");
  assert.equal(drilldown.conversions.length, 1, "completing the service must not remove the credit");
});

test("C1: the lead keeps its audit trail even when the booking is cancelled", async () => {
  const { sqlite } = await creditWorld("cancelled");
  const lead = leadRow(sqlite, "LEAD-C");
  assert.equal(lead.converted_booking_id, "BK-C", "history is preserved; only the credit is withdrawn");
  assert.equal(lead.status, "converted");
});

// --- assignment boundary on the credit path -------------------------------

test("a rep is not credited for a conversion outside their assignment window", async () => {
  const { sqlite, db, conversion, productivity } = await world();
  seedBooking(sqlite, { id: "BK-6", customerId: "CU-6", createdAt: NOW - 2 * DAY });
  seedLead(sqlite, { id: "LEAD-6", customerId: "CU-6", initiatedBookingId: "BK-6" });
  // the assignment ended before the booking was created
  seedAssignment(sqlite, { id: "ASSIGN-6", leadId: "LEAD-6", email: "rep.past@pawspace.in", assignedAt: NOW - 20 * DAY, endedAt: NOW - 10 * DAY });
  await conversion.convertLeadOnPaymentCaptured(db, { customerId: "CU-6", bookingId: "BK-6" });
  const drilldown = await productivity.salesProductivityDrilldown(db, { employeeEmail: "rep.past@pawspace.in", periodStart: PERIOD_START, periodEnd: PERIOD_END });
  assert.equal(drilldown.conversions.length, 0, "credit follows who owned the lead when the booking happened");
});

test("another rep cannot claim a conversion they never owned", async () => {
  const { sqlite, db, conversion, productivity } = await world();
  seedBooking(sqlite, { id: "BK-7", customerId: "CU-7", createdAt: NOW - 2 * DAY });
  seedLead(sqlite, { id: "LEAD-7", customerId: "CU-7", initiatedBookingId: "BK-7" });
  seedAssignment(sqlite, { id: "ASSIGN-7", leadId: "LEAD-7", email: "rep.owner@pawspace.in" });
  await conversion.convertLeadOnPaymentCaptured(db, { customerId: "CU-7", bookingId: "BK-7" });
  const owner = await productivity.salesProductivityDrilldown(db, { employeeEmail: "rep.owner@pawspace.in", periodStart: PERIOD_START, periodEnd: PERIOD_END });
  const other = await productivity.salesProductivityDrilldown(db, { employeeEmail: "rep.other@pawspace.in", periodStart: PERIOD_START, periodEnd: PERIOD_END });
  assert.equal(owner.conversions.length, 1);
  assert.equal(other.conversions.length, 0);
});

test("employee email matching is case-insensitive but still exact", async () => {
  const { sqlite, db, conversion, productivity } = await world();
  seedBooking(sqlite, { id: "BK-8", customerId: "CU-8", createdAt: NOW - 2 * DAY });
  seedLead(sqlite, { id: "LEAD-8", customerId: "CU-8", initiatedBookingId: "BK-8" });
  seedAssignment(sqlite, { id: "ASSIGN-8", leadId: "LEAD-8", email: "Rep.Mixed@PawSpace.in" });
  await conversion.convertLeadOnPaymentCaptured(db, { customerId: "CU-8", bookingId: "BK-8" });
  const found = await productivity.salesProductivityDrilldown(db, { employeeEmail: "REP.MIXED@pawspace.in", periodStart: PERIOD_START, periodEnd: PERIOD_END });
  assert.equal(found.conversions.length, 1, "case differences must not lose a rep's own credit");
  const near = await productivity.salesProductivityDrilldown(db, { employeeEmail: "rep.mixed@pawspace.in.example", periodStart: PERIOD_START, periodEnd: PERIOD_END });
  assert.equal(near.conversions.length, 0, "a similar address is not the same person");
});

// --- multi-city consistency ---------------------------------------------

test("two cities convert and credit independently on one run", async () => {
  const { sqlite, db, conversion, productivity } = await world();
  for (const [city, rep] of [["blr", "rep.blr@pawspace.in"], ["hyd", "rep.hyd@pawspace.in"]]) {
    seedBooking(sqlite, { id: `BK-${city}`, customerId: `CU-${city}`, createdAt: NOW - 2 * DAY, city });
    seedLead(sqlite, { id: `LEAD-${city}`, customerId: `CU-${city}`, initiatedBookingId: `BK-${city}`, city });
    seedAssignment(sqlite, { id: `ASSIGN-${city}`, leadId: `LEAD-${city}`, email: rep, teamCode: `sales_${city}` });
    await conversion.convertLeadOnPaymentCaptured(db, { customerId: `CU-${city}`, bookingId: `BK-${city}` });
  }
  const blr = await productivity.salesProductivityDrilldown(db, { employeeEmail: "rep.blr@pawspace.in", periodStart: PERIOD_START, periodEnd: PERIOD_END });
  const hyd = await productivity.salesProductivityDrilldown(db, { employeeEmail: "rep.hyd@pawspace.in", periodStart: PERIOD_START, periodEnd: PERIOD_END });
  assert.equal(blr.conversions.length, 1);
  assert.equal(hyd.conversions.length, 1);
  assert.equal(blr.conversions[0].booking_id, "BK-blr", "no cross-city credit leakage");
  assert.equal(hyd.conversions[0].booking_id, "BK-hyd");
});

test("cancelling one city's booking does not disturb the other city's credit", async () => {
  const { sqlite, db, conversion, productivity } = await world();
  for (const [city, rep] of [["blr", "rep.blr@pawspace.in"], ["hyd", "rep.hyd@pawspace.in"]]) {
    seedBooking(sqlite, { id: `BK-${city}`, customerId: `CU-${city}`, createdAt: NOW - 2 * DAY, city });
    seedLead(sqlite, { id: `LEAD-${city}`, customerId: `CU-${city}`, initiatedBookingId: `BK-${city}`, city });
    seedAssignment(sqlite, { id: `ASSIGN-${city}`, leadId: `LEAD-${city}`, email: rep, teamCode: `sales_${city}` });
    await conversion.convertLeadOnPaymentCaptured(db, { customerId: `CU-${city}`, bookingId: `BK-${city}` });
  }
  sqlite.prepare("UPDATE canonical_bookings SET status='cancelled' WHERE id='BK-blr'").run();
  const blr = await productivity.salesProductivityDrilldown(db, { employeeEmail: "rep.blr@pawspace.in", periodStart: PERIOD_START, periodEnd: PERIOD_END });
  const hyd = await productivity.salesProductivityDrilldown(db, { employeeEmail: "rep.hyd@pawspace.in", periodStart: PERIOD_START, periodEnd: PERIOD_END });
  assert.equal(blr.conversions.length, 0);
  assert.equal(hyd.conversions.length, 1, "one city's cancellation is not the other's problem");
});

// --- duplicate leads on the same customer -------------------------------

test("two open leads for one customer yield exactly one conversion", async () => {
  const { sqlite, db, conversion } = await world();
  seedBooking(sqlite, { id: "BK-9", customerId: "CU-9", createdAt: NOW - 2 * DAY });
  seedLead(sqlite, { id: "LEAD-9a", customerId: "CU-9" });
  seedLead(sqlite, { id: "LEAD-9b", customerId: "CU-9" });
  await conversion.convertLeadOnPaymentCaptured(db, { customerId: "CU-9", bookingId: "BK-9" });
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM lead_work_items WHERE status='converted'").get().c, 1,
    "a duplicate lead must not turn one booking into two conversions");
});

test("concurrent conversion of the same booking credits it once", async () => {
  const { sqlite, db, conversion } = await world();
  seedBooking(sqlite, { id: "BK-10", customerId: "CU-10", createdAt: NOW - 2 * DAY });
  seedLead(sqlite, { id: "LEAD-10", customerId: "CU-10", initiatedBookingId: "BK-10" });
  await Promise.all([
    conversion.convertLeadOnPaymentCaptured(db, { customerId: "CU-10", bookingId: "BK-10" }),
    conversion.convertLeadOnPaymentCaptured(db, { customerId: "CU-10", bookingId: "BK-10" }),
  ]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM lead_work_items WHERE converted_booking_id='BK-10'").get().c, 1);
});
