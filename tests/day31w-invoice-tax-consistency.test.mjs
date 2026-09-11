/*
 * Day-31 wave 1d: the Dog Walking and Pet Taxi tax invoices.
 *
 * published city tax policy -> paid booking -> invoice number series -> gross / tax / net.
 *
 * A booking_invoices row is a GST document. Two things about it are read by the statutory close
 * rather than by a screen, so an error is not visible until a filing:
 *
 *   gross_amount must be what the customer was actually charged
 *   gross_amount - tax_amount must be the taxable value
 *
 * lib/service-output-tax.ts - the single place that decides how much of the collected GST is
 * PawSpace's own output tax - computes the taxable value as exactly `bi.gross_amount -
 * bi.tax_amount`. So whatever these issuers write has to satisfy that identity in EVERY tax mode
 * the Ops console can publish, not just the one currently in use.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world } from "./helpers/execution-harness.mjs";

installWorkersHooks("__D31W_INV_DB__", "__D31W_INV_ENV__");

const CITY = "blr";
const CUSTOMER = "CUS-INV-001";
const OPS = "finance@pawspace.in";

/** Each vertical, with the module that issues its invoice and the booking shape it demands. */
const VERTICALS = [
  { name: "Dog Walking", module: "../lib/walking-invoice.ts", serviceCode: "dog_walking",
    ensure: "ensureWalkingInvoiceTables", savePolicy: "saveWalkingTaxPolicy", issue: "issueWalkingInvoice", prefix: "WLK" },
  { name: "Pet Taxi", module: "../lib/taxi-invoice.ts", serviceCode: "pet_taxi",
    ensure: "ensureTaxiInvoiceTables", savePolicy: "saveTaxiTaxPolicy", issue: "issueTaxiInvoice", prefix: "TXI" },
];

async function seedInvoice(vertical, { taxMode = "inclusive", taxRate = 18, total = 1180, bookingId = "BK-INV-001", paid = true } = {}) {
  const { sqlite, db } = world("__D31W_INV_DB__", "__D31W_INV_ENV__");
  const mod = await import(vertical.module);
  await mod[vertical.ensure](db);

  const now = Date.now();
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,provider_id TEXT,status TEXT,total_amount REAL,currency TEXT,scheduled_start TEXT)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT UNIQUE,detail_json TEXT DEFAULT '{}',created_at INTEGER,updated_at INTEGER)");
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,service_code,status,total_amount,currency,scheduled_start) VALUES (?,?,?,?,'completed',?,'INR',?)")
    .run(bookingId, CUSTOMER, CITY, vertical.serviceCode, total, new Date(now).toISOString());
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,'INR','razorpay','full',?,'uat_sandbox',?,?,?)")
    .run(`PAY-${bookingId}`, bookingId, CUSTOMER, total, total, paid ? "paid" : "pending", `idem-${bookingId}`, now, now);

  await mod[vertical.savePolicy](db, {
    cityId: CITY, taxMode, taxRate, effectiveFrom: "2026-04-01",
    actorId: OPS, reason: "Day-31 published city tax policy",
  });
  return { sqlite, db, mod, bookingId };
}

const invoiceRow = (sqlite, bookingId) =>
  sqlite.prepare("SELECT gross_amount,tax_amount,net_amount,invoice_number,status FROM booking_invoices WHERE booking_id=?").get(bookingId);

for (const vertical of VERTICALS) {
  test(`${vertical.name}: an invoice cannot be issued before the money is in`, async () => {
    const { db, mod, bookingId } = await seedInvoice(vertical, { paid: false });
    await assert.rejects(
      () => mod[vertical.issue](db, { bookingId, reason: "Day-31 premature invoice", actorId: OPS }),
      (error) => { assert.equal(error.status, 409); return true; },
      "a tax invoice states money was received - it must not precede the payment",
    );
  });

  test(`${vertical.name}: an invoice cannot be issued without a published city tax policy`, async () => {
    const { sqlite, db, mod, bookingId } = await seedInvoice(vertical);
    sqlite.exec("DELETE FROM " + (vertical.prefix === "WLK" ? "walking_tax_policies" : "taxi_tax_policies"));
    await assert.rejects(
      () => mod[vertical.issue](db, { bookingId, reason: "Day-31 invoice with no tax policy", actorId: OPS }),
      (error) => { assert.equal(error.status, 409); return true; },
      "guessing a tax rate on a statutory document is never acceptable",
    );
  });

  test(`${vertical.name}: gross minus tax is the taxable value, in BOTH published tax modes`, async () => {
    /*
     * THE IDENTITY THE STATUTORY CLOSE DEPENDS ON. Ops can publish either mode - saveTaxPolicy
     * accepts "inclusive" and "exclusive" alike - so both must produce an invoice whose own
     * gross_amount is what the customer paid and whose gross minus tax is the taxable base.
     *
     * On an exclusive policy the customer pays total + tax, so an invoice recording only `total`
     * as its gross both understates the document and, read through service-output-tax.ts, reports
     * a taxable value short by the whole tax amount.
     */
    for (const [taxMode, total, expectedGross, expectedTax] of [
      ["inclusive", 1180, 1180, 180],   // Rs 1,180 charged, Rs 180 of it is GST
      ["exclusive", 1000, 1180, 180],   // Rs 1,000 plus 18% -> Rs 1,180 charged
    ]) {
      const { sqlite, db, mod, bookingId } = await seedInvoice(vertical, { taxMode, taxRate: 18, total });
      await mod[vertical.issue](db, { bookingId, reason: `Day-31 ${taxMode} tax invoice`, actorId: OPS });
      const row = invoiceRow(sqlite, bookingId);

      assert.equal(row.tax_amount, expectedTax, `${taxMode}: the GST component`);
      assert.equal(row.gross_amount, expectedGross,
        `${taxMode}: gross_amount must be what the customer was charged`);
      assert.equal(Math.round((row.gross_amount - row.tax_amount) * 100) / 100, 1000,
        `${taxMode}: gross minus tax must be the taxable value service-output-tax.ts reads`);
    }
  });

  test(`${vertical.name}: the invoice number is a real per-city, per-financial-year series`, async () => {
    const { sqlite, db, mod } = await seedInvoice(vertical, { bookingId: "BK-INV-A" });
    await mod[vertical.issue](db, { bookingId: "BK-INV-A", reason: "Day-31 first invoice of the series", actorId: OPS });
    const now = Date.now();
    sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,service_code,status,total_amount,currency,scheduled_start) VALUES (?,?,?,?,'completed',1180,'INR',?)")
      .run("BK-INV-B", CUSTOMER, CITY, vertical.serviceCode, new Date(now).toISOString());
    sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,created_at,updated_at) VALUES (?,?,?,1180,1180,'INR','razorpay','full','paid','uat_sandbox',?,?,?)")
      .run("PAY-BK-INV-B", "BK-INV-B", CUSTOMER, "idem-BK-INV-B", now, now);
    await mod[vertical.issue](db, { bookingId: "BK-INV-B", reason: "Day-31 second invoice of the series", actorId: OPS });

    const numbers = sqlite.prepare("SELECT invoice_number FROM booking_invoices ORDER BY invoice_number").all().map((r) => r.invoice_number);
    assert.equal(numbers.length, 2);
    for (const number of numbers) {
      assert.match(number, new RegExp(`^${vertical.prefix}-BLR-\\d{2}-\\d{2}-\\d{6}$`),
        `an invoice number must identify its city and financial year: ${number}`);
    }
    assert.equal(new Set(numbers).size, 2, "two invoices may never share a number");
    const sequence = numbers.map((n) => Number(n.slice(-6)));
    assert.deepEqual(sequence, [1, 2], "the statutory series must be consecutive with no gap");
  });

  test(`${vertical.name}: issuing twice returns the same invoice and never renumbers it`, async () => {
    const { sqlite, db, mod, bookingId } = await seedInvoice(vertical);
    const first = await mod[vertical.issue](db, { bookingId, reason: "Day-31 original issue", actorId: OPS });
    const second = await mod[vertical.issue](db, { bookingId, reason: "Day-31 duplicate issue attempt", actorId: OPS });
    assert.equal(second.duplicatePrevented, true);
    assert.equal(second.invoiceNumber, first.invoiceNumber, "a reissued invoice must keep its number");
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM booking_invoices WHERE booking_id=?").get(bookingId).n, 1);
    assert.equal(first.liveTaxFiling, false, "nothing here is filed with the tax authority yet");
  });
}

test("the output-tax split reads the issued invoices back consistently", async () => {
  /*
   * End to end across the module boundary: issue a real invoice, then have the statutory close's
   * own splitter read it. This is what makes the identity above load-bearing rather than cosmetic.
   */
  const { sqlite, db, mod, bookingId } = await seedInvoice(VERTICALS[0], { taxMode: "exclusive", taxRate: 18, total: 1000 });
  await mod.issueWalkingInvoice(db, { bookingId, reason: "Day-31 cross-module read-back", actorId: OPS });
  const { serviceVerticalOutputTax } = await import("../lib/service-output-tax.ts");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_payout_computations (booking_id TEXT PRIMARY KEY,provider_id TEXT,service_code TEXT,order_value REAL,provider_gst_deducted REAL,platform_gst REAL,platform_fee REAL,term_id TEXT,computed_at INTEGER)");

  const split = await serviceVerticalOutputTax(db, Date.now() - 86400000, Date.now() + 86400000);
  assert.equal(split.totalTaxCollected, 180);
  assert.equal(split.pawspaceOwnTaxableValue, 1000,
    "the taxable value the close reports must be the Rs 1,000 actually supplied, not gross minus tax on an understated gross");
});
