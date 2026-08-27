/**
 * Lead attribution without a service match. [PTJA-W3-LA, closing PTJA-P1-F1's remaining half]
 *
 * THE APPROVED RULE, supplied by the business:
 *   Never credit the newest unrelated open lead. A booking may be attributed only to a lead matching
 *   the relevant customer AND service. If no lead matches: credit no existing lead, and record the
 *   booking as `direct_booking` or equivalent system-origin attribution. If the Identity Spine requires
 *   an originating record, create a clearly labelled system/direct-booking source record rather than
 *   modifying an unrelated marketing lead. This prevents false campaign and sales-conversion reporting.
 *
 * WHAT WAS MEASURED BEFORE. attributeBookingToOpenLead prefers a lead whose service matches what was
 * booked - that half was closed as P1-F1 - and then falls back to "the customer's newest open lead"
 * with no reference to the service at all. So a customer whose only open lead is a BOARDING enquiry,
 * who books GROOMING, had the Boarding lead marked converted by a booking that had nothing to do with
 * it: the Boarding rep was credited with a conversion they did not make, and the Boarding enquiry was
 * closed while the customer was still waiting to hear about boarding. convertLeadOnPaymentCaptured
 * carried the same fallback.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_LA_DB__", "__PTJA_LA_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  let depth = 0;
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      const outer = depth === 0;
      if (outer) sqlite.exec("BEGIN IMMEDIATE");
      depth += 1;
      try { const out = []; for (const item of items) out.push(await item.run()); if (outer) sqlite.exec("COMMIT"); return out; }
      catch (error) { if (outer) sqlite.exec("ROLLBACK"); throw error; }
      finally { depth -= 1; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const CUSTOMER = "CUS-1";

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_LA_DB__ = db;
  globalThis.__PTJA_LA_ENV__ = {};
  const attribution = await import("../lib/lead-conversion-attribution.ts");
  await attribution.ensureLeadWorkItemsTable(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,service_code TEXT,status TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT,customer_id TEXT,amount REAL,status TEXT,created_at INTEGER,updated_at INTEGER)");
  return { sqlite, db, attribution };
}

const now = () => Date.now();

const seedLead = (sqlite, { id, service, assignedAt, status = "active" }) =>
  sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,call_attempts,whatsapp_attempts,recycle_cycle,opt_out,created_at,updated_at) VALUES (?,?,'Website',?,'Neha','Manager',?,'day_1',1,?,?,?,0,0,0,0,?,?)")
    .run(id, CUSTOMER, service, status, assignedAt, assignedAt, assignedAt, assignedAt, assignedAt);

const seedBooking = (sqlite, { id, serviceCode, paymentStatus = "awaiting_payment" }) => {
  const stamp = now();
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,status,created_at,updated_at) VALUES (?,?,?,'confirmed',?,?)").run(id, CUSTOMER, serviceCode, stamp, stamp);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,status,created_at,updated_at) VALUES (?,?,?,5000,?,?,?)").run(`PAY-${id}`, id, CUSTOMER, paymentStatus, stamp, stamp);
};

// ---------------------------------------------------------------------------------------------------
// A matching lead is still credited
// ---------------------------------------------------------------------------------------------------

test("LA-01: a booking credits the open lead for the service that was actually booked", async () => {
  // Non-vacuity for everything below. Crediting nobody at all would satisfy the refusal cases and
  // silently zero every genuine sales conversion.
  const { sqlite, db, attribution } = await world();
  const stamp = now();
  seedLead(sqlite, { id: "LEAD-GROOM", service: "grooming", assignedAt: stamp - 100_000 });
  seedLead(sqlite, { id: "LEAD-BOARD", service: "boarding", assignedAt: stamp });
  seedBooking(sqlite, { id: "BK-1", serviceCode: "grooming", paymentStatus: "captured" });

  const result = await attribution.attributeBookingToOpenLead(db, { customerId: CUSTOMER, bookingId: "BK-1" });
  assert.equal(result?.leadId, "LEAD-GROOM", `the grooming lead is credited, not the newer boarding one: ${JSON.stringify(result)}`);
  assert.equal(String(sqlite.prepare("SELECT status FROM lead_work_items WHERE id='LEAD-BOARD'").get().status), "active",
    "and the boarding lead is untouched");
});

// ---------------------------------------------------------------------------------------------------
// No matching lead — credit nobody, record direct_booking
// ---------------------------------------------------------------------------------------------------

test("LA-02: with only an unrelated open lead, no lead is credited", async () => {
  const { sqlite, db, attribution } = await world();
  const stamp = now();
  seedLead(sqlite, { id: "LEAD-BOARD", service: "boarding", assignedAt: stamp });
  seedBooking(sqlite, { id: "BK-2", serviceCode: "grooming", paymentStatus: "captured" });

  const result = await attribution.attributeBookingToOpenLead(db, { customerId: CUSTOMER, bookingId: "BK-2" });
  assert.notEqual(result?.leadId, "LEAD-BOARD", `an unrelated lead must not be credited: ${JSON.stringify(result)}`);
  const lead = sqlite.prepare("SELECT status,converted_booking_id,last_outcome,initiated_booking_id FROM lead_work_items WHERE id='LEAD-BOARD'").get();
  assert.equal(String(lead.status), "active", "the boarding enquiry stays open - the customer is still waiting to hear about boarding");
  assert.equal(lead.converted_booking_id, null, "and is not marked converted");
  assert.equal(lead.initiated_booking_id, null, "and is not linked to the grooming booking either");
  assert.equal(lead.last_outcome, null, "and its outcome is not rewritten");
});

test("LA-03: the booking is recorded as a direct booking instead", async () => {
  const { sqlite, db, attribution } = await world();
  seedLead(sqlite, { id: "LEAD-BOARD", service: "boarding", assignedAt: now() });
  seedBooking(sqlite, { id: "BK-3", serviceCode: "grooming", paymentStatus: "captured" });

  const result = await attribution.attributeBookingToOpenLead(db, { customerId: CUSTOMER, bookingId: "BK-3" });
  assert.equal(result?.attribution, "direct_booking", `the origin is stated, not left blank: ${JSON.stringify(result)}`);
  const row = sqlite.prepare("SELECT * FROM booking_attribution WHERE booking_id='BK-3'").get();
  assert.ok(row, "a system-origin record is written rather than an unrelated lead being modified");
  assert.equal(String(row.attribution_type), "direct_booking", "clearly labelled");
  assert.equal(row.lead_id, null, "crediting no lead");
  assert.equal(String(row.service_code), "grooming", "and naming what was booked");
});

test("LA-04: a customer with no leads at all is a direct booking, not an error", async () => {
  const { sqlite, db, attribution } = await world();
  seedBooking(sqlite, { id: "BK-4", serviceCode: "pet_taxi", paymentStatus: "captured" });
  const result = await attribution.attributeBookingToOpenLead(db, { customerId: CUSTOMER, bookingId: "BK-4" });
  assert.equal(result?.attribution, "direct_booking", `a walk-in books without a campaign behind them: ${JSON.stringify(result)}`);
  assert.equal(String(sqlite.prepare("SELECT attribution_type FROM booking_attribution WHERE booking_id='BK-4'").get().attribution_type), "direct_booking");
});

test("LA-05: a matched lead is recorded as a lead attribution, not a direct booking", async () => {
  // Non-vacuity for LA-03 and LA-04. Recording everything as direct_booking would satisfy both and
  // zero every campaign figure.
  const { sqlite, db, attribution } = await world();
  seedLead(sqlite, { id: "LEAD-GROOM", service: "grooming", assignedAt: now() });
  seedBooking(sqlite, { id: "BK-5", serviceCode: "grooming", paymentStatus: "captured" });
  await attribution.attributeBookingToOpenLead(db, { customerId: CUSTOMER, bookingId: "BK-5" });
  const row = sqlite.prepare("SELECT attribution_type,lead_id FROM booking_attribution WHERE booking_id='BK-5'").get();
  assert.equal(String(row.attribution_type), "lead", "a genuine conversion is still recorded as one");
  assert.equal(String(row.lead_id), "LEAD-GROOM", "naming the lead that earned it");
});

// ---------------------------------------------------------------------------------------------------
// The payment-capture path carried the same fallback
// ---------------------------------------------------------------------------------------------------

test("LA-06: capture converts the lead this booking was actually linked to", async () => {
  const { sqlite, db, attribution } = await world();
  const stamp = now();
  seedLead(sqlite, { id: "LEAD-GROOM", service: "grooming", assignedAt: stamp - 100_000 });
  seedBooking(sqlite, { id: "BK-6", serviceCode: "grooming" });
  await attribution.attributeBookingToOpenLead(db, { customerId: CUSTOMER, bookingId: "BK-6" });
  seedLead(sqlite, { id: "LEAD-LATER", service: "boarding", assignedAt: stamp + 100_000 });

  const converted = await attribution.convertLeadOnPaymentCaptured(db, { customerId: CUSTOMER, bookingId: "BK-6" });
  assert.equal(converted?.leadId, "LEAD-GROOM", `the linked lead converts: ${JSON.stringify(converted)}`);
  assert.equal(String(sqlite.prepare("SELECT status FROM lead_work_items WHERE id='LEAD-LATER'").get().status), "active",
    "and a newer unrelated lead is not swept up by the capture");
});

test("LA-07: capture with nothing linked does not grab the newest open lead", async () => {
  const { sqlite, db, attribution } = await world();
  seedLead(sqlite, { id: "LEAD-BOARD", service: "boarding", assignedAt: now() });
  seedBooking(sqlite, { id: "BK-7", serviceCode: "grooming", paymentStatus: "captured" });

  const converted = await attribution.convertLeadOnPaymentCaptured(db, { customerId: CUSTOMER, bookingId: "BK-7" });
  assert.notEqual(converted?.leadId, "LEAD-BOARD", `an unrelated lead must not be converted at capture: ${JSON.stringify(converted)}`);
  assert.equal(String(sqlite.prepare("SELECT status FROM lead_work_items WHERE id='LEAD-BOARD'").get().status), "active",
    "the boarding enquiry stays open");
  assert.equal(String(sqlite.prepare("SELECT attribution_type FROM booking_attribution WHERE booking_id='BK-7'").get().attribution_type), "direct_booking",
    "and the booking is recorded as direct");
});

// ---------------------------------------------------------------------------------------------------
// Reporting, and replays
// ---------------------------------------------------------------------------------------------------

test("LA-08: attribution is recorded once, however many times the hook runs", async () => {
  const { sqlite, db, attribution } = await world();
  seedBooking(sqlite, { id: "BK-8", serviceCode: "grooming", paymentStatus: "captured" });
  await attribution.attributeBookingToOpenLead(db, { customerId: CUSTOMER, bookingId: "BK-8" });
  await attribution.attributeBookingToOpenLead(db, { customerId: CUSTOMER, bookingId: "BK-8" });
  await attribution.convertLeadOnPaymentCaptured(db, { customerId: CUSTOMER, bookingId: "BK-8" });
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM booking_attribution WHERE booking_id='BK-8'").get().c), 1,
    "a replayed hook must not inflate the direct-booking count either");
});

test("LA-09: conversion reporting can separate campaign conversions from direct bookings", async () => {
  const { sqlite, db, attribution } = await world();
  seedLead(sqlite, { id: "LEAD-GROOM", service: "grooming", assignedAt: now() });
  seedBooking(sqlite, { id: "BK-9A", serviceCode: "grooming", paymentStatus: "captured" });
  seedBooking(sqlite, { id: "BK-9B", serviceCode: "boarding", paymentStatus: "captured" });
  await attribution.attributeBookingToOpenLead(db, { customerId: CUSTOMER, bookingId: "BK-9A" });
  await attribution.attributeBookingToOpenLead(db, { customerId: CUSTOMER, bookingId: "BK-9B" });

  const summary = await attribution.bookingAttributionSummary(db);
  assert.equal(summary.lead, 1, `one genuine campaign conversion: ${JSON.stringify(summary)}`);
  assert.equal(summary.direct_booking, 1, "and one direct booking, counted separately rather than inflating the campaign figure");
});
