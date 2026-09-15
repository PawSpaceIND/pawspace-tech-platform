/*
 * R3-C / F4 (P1) — a supported GST mode made every assisted order impossible, and blamed the catalogue.
 *
 * MEASURED: with `blr` published as EXCLUSIVE 18% through /api/grooming-finance save_tax_policy, every
 * one-pet assisted order was refused:
 *   409 "/api/canonical-bookings refused this assisted order: Submitted Grooming total does not match
 *        governed catalogue <version>"
 * generateCanonicalSalesQuote returns the GST-ADDED total (1899 x 1.18 = 2240.82), while
 * lib/grooming-governance.ts compared the submitted total to the BARE catalogue price (1899).
 * Re-publishing the SAME policy as `inclusive` made the identical request succeed. Both modes are
 * first-class in the save_tax_policy API; only one of them could produce a booking.
 *
 * The multi-pet path (lib/live-grooming-governance.ts) had always grossed an exclusive subtotal up -
 * so this was one rule implemented twice with one copy missing, not an undecided question.
 *
 * These tests run the REAL /api/assisted-orders POST. The internal /api/canonical-bookings boundary is
 * represented by a stub that calls the REAL governGroomingBookingWithLiveMultiPet with the body it
 * receives - the same call app/api/canonical-bookings/route.ts:272 makes - so the refusal under test is
 * the refusal that was measured, produced by the real governance code.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { installWorkersHooks, enterWorkersDbScope } from "./helpers/module-hooks.mjs";

installWorkersHooks("__R3C_GST_DB__", "__R3C_GST_ENV__");

const ORIGIN = "https://uat.pawspace.in";
const STAFF = { "oai-authenticated-user-email": "ops.admin@pawspace.test" };

async function world(taxMode, taxRate = 18) {
  const harness = freshCountingD1();
  const { sqlite, db } = harness;
  enterWorkersDbScope(db);
  globalThis.__R3C_GST_DB__ = db;
  globalThis.__R3C_GST_ENV__ = {};
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,name TEXT NOT NULL,species TEXT NOT NULL,breed TEXT,vaccination_status TEXT NOT NULL DEFAULT 'not_provided',source_pet_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,service_code TEXT,status TEXT,total_amount REAL,currency TEXT,channel TEXT,provider_id TEXT,schedule_group_id TEXT,scheduled_start TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT,provider_name TEXT,provider_model TEXT,created_at INTEGER);
    CREATE TABLE IF NOT EXISTS booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT,event_type TEXT,entity_type TEXT,entity_id TEXT,actor_id TEXT,detail_json TEXT,occurred_at INTEGER);
  `);
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const now = Date.now();
  await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-ADMIN',?,?,'admin','active',?,?)")
    .bind(STAFF["oai-authenticated-user-email"], "Ops Admin", now, now).run();
  const { ensureGroomingInvoiceTables } = await import("../lib/grooming-invoice.ts");
  await ensureGroomingInvoiceTables(db);
  // Exactly what /api/grooming-finance save_tax_policy publishes.
  await db.prepare("INSERT INTO grooming_tax_policies (city_id,tax_mode,tax_rate,status,version,updated_by,updated_at) VALUES ('blr',?,?,'published',1,'finance@pawspace.test',?)")
    .bind(taxMode, taxRate, now).run();
  return harness;
}

/** The internal chain, with the REAL grooming governance standing where /api/canonical-bookings runs it. */
function chain(sqlite) {
  const sent = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const body = JSON.parse(String(init.body ?? "{}"));
    sent.push({ url, body });
    if (url.includes("/api/uat-scheduling")) return Response.json({ data: { groupId: body.clientRequestId, provider: { id: "PRV-1", name: "UAT Groomer", model: "full_time" } } });
    if (url.includes("/api/canonical-bookings")) {
      const { governGroomingBookingWithLiveMultiPet } = await import("../lib/live-grooming-governance.ts");
      try {
        const governed = await governGroomingBookingWithLiveMultiPet(globalThis.__R3C_GST_DB__, {
          packageCode: body.packageCode, packageName: body.packageName,
          pets: body.pets.map((pet) => ({ species: pet.species ?? "other" })),
          submittedTotal: body.totalAmount, submittedAmountDueNow: body.payment.mode === "prepaid" ? body.totalAmount : 0,
          paymentMode: body.payment.mode, cityId: body.cityId, zoneId: body.zoneId, scheduledStart: body.scheduledStart,
        });
        sqlite.prepare("INSERT OR IGNORE INTO canonical_bookings (id,customer_id,service_code,status,total_amount,currency,channel,provider_id,schedule_group_id,scheduled_start,created_at,updated_at) VALUES ('BK-GST',?,'grooming','confirmed',?,'INR','customer_app',?,?,?,?,?)")
          .run(body.customer.id, governed.totalAmount, body.provider.id, body.scheduleGroupId, String(body.scheduledStart), Date.now(), Date.now());
        return Response.json({ data: { bookingId: "BK-GST", governedTotal: governed.totalAmount } });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "Invalid Grooming package or price" }, { status: 409 });
      }
    }
    throw new Error(`unexpected internal call: ${url}`);
  };
  return { sent, restore: () => { globalThis.fetch = original; }, to: (path) => sent.find((call) => call.url.includes(path)) };
}

const order = () => new Request(`${ORIGIN}/api/assisted-orders`, {
  method: "POST", headers: { ...STAFF, "content-type": "application/json" },
  body: JSON.stringify({
    idempotencyKey: `gst-${Math.random().toString(36).slice(2)}`,
    customer: { id: "UAT-CUST-ASSIST-001", name: "Meera Shah", primaryPhone: "+919800000101" },
    pets: [{ sourceId: "UAT-PET-BRUNO", name: "Bruno", species: "dog" }],
    cityId: "blr", zoneId: "blr-east", packageCode: "dog-basic",
    scheduledStart: "2026-10-01T04:30:00.000Z", scheduledEnd: "2026-10-01T06:30:00.000Z",
    consent: { captured: true, method: "recorded_call", reference: "UAT-CALL-REF-001" },
  }),
});

test("GST-01: with the city published as EXCLUSIVE, a one-pet assisted order is created", async () => {
  const harness = await world("exclusive");
  const link = chain(harness.sqlite);
  try {
    // NON-VACUITY: the quote really does add GST, which is the number the governance used to reject.
    const { generateCanonicalSalesQuote } = await import("../lib/sales-core-tools.ts");
    const quote = await generateCanonicalSalesQuote(harness.db, { packageCode: "dog-basic", petCount: 1, cityId: "blr" });
    assert.equal(quote.taxMode, "exclusive");
    assert.ok(quote.totalAmount > 1899, `an exclusive quote adds GST on top of 1899: ${quote.totalAmount}`);

    const route = await import("../app/api/assisted-orders/route.ts");
    const response = await route.POST(order());
    const body = await response.json();
    assert.equal(response.status, 201, `exclusive GST must not make booking impossible: ${JSON.stringify(body).slice(0, 400)}`);
    assert.equal(body.data.totalAmount, quote.totalAmount, "the order carries the governed GST-added total");
    assert.equal(harness.sqlite.prepare("SELECT total_amount t FROM canonical_bookings WHERE id='BK-GST'").get().t, quote.totalAmount,
      "and the canonical booking was written with it");
  } finally { link.restore(); }
});

test("GST-02: the same request still works when the city is published as INCLUSIVE", async () => {
  const harness = await world("inclusive");
  const link = chain(harness.sqlite);
  try {
    const { generateCanonicalSalesQuote } = await import("../lib/sales-core-tools.ts");
    const quote = await generateCanonicalSalesQuote(harness.db, { packageCode: "dog-basic", petCount: 1, cityId: "blr" });
    assert.equal(quote.totalAmount, 1899, "an inclusive quote is the catalogue price");
    const route = await import("../app/api/assisted-orders/route.ts");
    const response = await route.POST(order());
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body).slice(0, 300));
    assert.equal(body.data.totalAmount, 1899);
  } finally { link.restore(); }
});

test("GST-03: a total that really is wrong says what disagreed, not 'the catalogue'", async () => {
  const harness = await world("exclusive");
  const { governGroomingBooking } = await import("../lib/grooming-governance.ts");
  await assert.rejects(
    () => governGroomingBooking(harness.db, {
      packageCode: "dog-basic", pets: [{ species: "dog" }], submittedTotal: 1500, submittedAmountDueNow: 0,
      paymentMode: "pay_after_service", cityId: "blr",
    }),
    (error) => {
      assert.match(error.message, /submitted 1500/, "the message must name the submitted total");
      assert.match(error.message, /governed 2240\.82/, "and the governed total it disagrees with");
      assert.match(error.message, /1899/, "and the catalogue price it was built from");
      assert.match(error.message, /GST 18% exclusive for city blr/, "and the tax mode that produced the difference");
      return true;
    });
});

test("GST-04: a city with NO published policy is unchanged - the catalogue price is still the total", async () => {
  // The fix must not make a governed precondition out of something that never was one.
  const harness = freshCountingD1();
  enterWorkersDbScope(harness.db);
  globalThis.__R3C_GST_DB__ = harness.db;
  const { ensureGroomingInvoiceTables } = await import("../lib/grooming-invoice.ts");
  await ensureGroomingInvoiceTables(harness.db);
  const { governGroomingBooking } = await import("../lib/grooming-governance.ts");
  const governed = await governGroomingBooking(harness.db, {
    packageCode: "dog-basic", pets: [{ species: "dog" }], submittedTotal: 1899, submittedAmountDueNow: 0,
    paymentMode: "pay_after_service", cityId: "pnq",
  });
  assert.equal(governed.totalAmount, 1899);
  assert.equal(governed.pricingBreakdown.gstMode, "configuration_required");
});
