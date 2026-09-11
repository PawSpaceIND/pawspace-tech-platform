/*
 * Day-31 wave 1b: statutory tax - the s.52 GST TCS rate, and the service output-tax split.
 *
 * lib/tcs-rate.ts, lib/service-output-tax.ts and lib/statutory-tcs.ts had no test importing them.
 * These decide what PawSpace tells the government it owes. A wrong figure here is not a bug a
 * customer reports; it is one a notice reports, months later, with interest.
 *
 * Two properties carry almost all the risk:
 *
 *   THE RATE DATE. s.52 TCS halved from 1% to 0.5% on 2024-07-10. One boundary, in IST, decides
 *   which applies - and every consumer resolves it through the same helper, so a helper that
 *   disagrees with itself misstates the tax by 2x.
 *
 *   THE SPLIT. On a marketplace supply only the COMMISSION GST is PawSpace's own output tax; the
 *   provider's supply GST is the provider's liability and must never appear in PawSpace's own
 *   GSTR-1/3B. Getting that backwards overstates our own liability; getting it backwards the other
 *   way understates it. The module's stated rule is that anything it cannot split counts as
 *   PawSpace's own - erring towards over-declaring, never under.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world } from "./helpers/execution-harness.mjs";

installWorkersHooks("__D31W_TAX_DB__", "__D31W_TAX_ENV__");

const { tcsRateS52For, TCS_RATE_S52 } = await import("../lib/tcs-rate.ts");

const CHANGE_DAY = "2024-07-10";
/** The exact epoch millisecond of an India wall-clock time. */
const istInstant = (iso) => Date.parse(`${iso}+05:30`);

test("the s.52 rate changes on the right India day, not the right UTC day", async () => {
  const lastLegacyMoment = istInstant("2024-07-09T23:59:59.999");
  const firstNewMoment = istInstant("2024-07-10T00:00:00.000");

  assert.equal(tcsRateS52For(lastLegacyMoment).total, 0.01, "1% through the end of 9 July, India time");
  assert.equal(tcsRateS52For(firstNewMoment).total, 0.005, "0.5% from the first minute of 10 July");
  assert.equal(tcsRateS52For(firstNewMoment).version, TCS_RATE_S52.version);

  /*
   * The trap this boundary sets. 2024-07-09T20:00:00Z is already 01:30 on 10 July in India, so the
   * new rate applies - even though the UTC date still reads the 9th.
   */
  assert.equal(tcsRateS52For(Date.parse("2024-07-09T20:00:00Z")).total, 0.005,
    "an instant that is already the 10th in India takes the new rate");
  assert.equal(tcsRateS52For(Date.parse("2024-07-09T17:00:00Z")).total, 0.01,
    "22:30 on the 9th in India is still the old rate");
});

test("the same instant resolves to the same rate however it is expressed", async () => {
  /*
   * A string that names an INSTANT must be treated as one. Before this pass a string starting with
   * a date was sliced to its first ten characters while a number was shifted into IST first, so
   * "2024-07-09T23:00:00Z" returned 1% and the epoch milliseconds of that identical moment
   * returned 0.5% - a 2x tax difference decided by the argument's type. Every caller passes a
   * number today, but an ISO timestamp is exactly what canonical_bookings.scheduled_start holds.
   */
  for (const iso of [
    "2024-07-09T23:00:00Z",        // 10 July 04:30 IST -> new rate
    "2024-07-09T20:00:00Z",        // 10 July 01:30 IST -> new rate
    "2024-07-09T17:00:00Z",        // 9 July 22:30 IST  -> legacy rate
    "2024-07-10T00:00:00+05:30",   // exactly the change moment
    "2024-07-09T23:59:59+05:30",   // last legacy second
  ]) {
    const ms = Date.parse(iso);
    assert.equal(tcsRateS52For(iso).total, tcsRateS52For(ms).total,
      `string and number must agree for ${iso}`);
    assert.equal(tcsRateS52For(iso).total, tcsRateS52For(new Date(ms)).total,
      `string and Date must agree for ${iso}`);
  }
});

test("a date-only string is an India business date and is taken as written", async () => {
  assert.equal(tcsRateS52For("2024-07-09").total, 0.01);
  assert.equal(tcsRateS52For(CHANGE_DAY).total, 0.005);
  assert.equal(tcsRateS52For("2026-09-10").total, 0.005, "today's rate is the current one");
});

test("the rate always splits into halves intra-state and the full rate inter-state", async () => {
  for (const at of [istInstant("2024-01-01T10:00:00"), istInstant("2026-09-10T10:00:00")]) {
    const rate = tcsRateS52For(at);
    assert.equal(Math.round((rate.cgst + rate.sgst) * 1e6) / 1e6, rate.total,
      "an intra-state collection is CGST + SGST and must add to the full rate");
    assert.equal(rate.igst, rate.total, "an inter-state collection is IGST at the full rate");
    assert.equal(rate.cgst, rate.sgst, "CGST and SGST are equal halves");
    assert.ok(rate.version && rate.effectiveFrom, "every rate must carry its lineage for the filing");
  }
});

test("an unparseable effective date is refused rather than defaulted to a rate", async () => {
  for (const bad of ["", "   ", "not-a-date", "2024-13-45", Number.NaN, Infinity, null, undefined]) {
    assert.throws(() => tcsRateS52For(bad), /Invalid TCS effective date/,
      `"${String(bad)}" must not silently resolve to a tax rate`);
  }
});

/* -------------------------------------------------------------------------------------------- */

async function seedInvoices() {
  const { sqlite, db } = world("__D31W_TAX_DB__", "__D31W_TAX_ENV__");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_invoices (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,gross_amount REAL,tax_amount REAL,status TEXT,issued_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_payout_computations (booking_id TEXT PRIMARY KEY,provider_id TEXT,service_code TEXT,order_value REAL,provider_gst_deducted REAL,platform_gst REAL,platform_fee REAL,term_id TEXT,computed_at INTEGER)");
  const { serviceVerticalOutputTax } = await import("../lib/service-output-tax.ts");
  return { sqlite, db, serviceVerticalOutputTax };
}

const WINDOW = [Date.parse("2026-09-01T00:00:00Z"), Date.parse("2026-10-01T00:00:00Z")];
const issueInvoice = (sqlite, id, gross, tax, status = "issued") =>
  sqlite.prepare("INSERT INTO booking_invoices (id,booking_id,gross_amount,tax_amount,status,issued_at) VALUES (?,?,?,?,?,?)")
    .run(`INV-${id}`, id, gross, tax, status, Date.parse("2026-09-15T00:00:00Z"));

test("on a marketplace supply only the commission GST is PawSpace's own output tax", async () => {
  /*
   * Rs 1,180 inclusive, Rs 180 GST collected in total. PawSpace's commission carries Rs 36 of that;
   * the remaining Rs 144 is the provider's own supply GST, remitted through GSTR-8, and must never
   * appear in PawSpace's GSTR-1/3B.
   */
  const { sqlite, db, serviceVerticalOutputTax } = await seedInvoices();
  issueInvoice(sqlite, "BK-MKT-1", 1180, 180);
  sqlite.prepare("INSERT INTO provider_payout_computations (booking_id,provider_id,service_code,order_value,provider_gst_deducted,platform_gst,platform_fee,term_id,computed_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("BK-MKT-1", "PRV-1", "grooming", 1180, 180, 36, 200, "TERM-1", Date.parse("2026-09-15T00:00:00Z"));

  const split = await serviceVerticalOutputTax(db, ...WINDOW);
  assert.equal(split.totalTaxCollected, 180, "all the GST collected is still reported");
  assert.equal(split.pawspaceOwnOutputTax, 36, "only the commission GST is ours");
  assert.equal(split.providerSupplyGstOnBehalf, 144, "the rest is the provider's, via GSTR-8");
  assert.equal(
    Math.round((split.pawspaceOwnOutputTax + split.providerSupplyGstOnBehalf) * 100) / 100,
    split.totalTaxCollected,
    "the split must account for every rupee collected - none created, none lost",
  );
});

test("on a principal supply the whole invoice tax is PawSpace's own", async () => {
  const { sqlite, db, serviceVerticalOutputTax } = await seedInvoices();
  issueInvoice(sqlite, "BK-PRIN-1", 1180, 180);
  sqlite.prepare("INSERT INTO provider_payout_computations (booking_id,provider_id,service_code,order_value,provider_gst_deducted,platform_gst,platform_fee,term_id,computed_at) VALUES (?,?,?,?,0,0,?,?,?)")
    .run("BK-PRIN-1", "EMP-1", "grooming", 1180, 1180, "TERM-2", Date.parse("2026-09-15T00:00:00Z"));

  const split = await serviceVerticalOutputTax(db, ...WINDOW);
  assert.equal(split.pawspaceOwnOutputTax, 180, "with no provider GST carved out, PawSpace is the supplier of record");
  assert.equal(split.providerSupplyGstOnBehalf, 0);
});

test("an invoice that cannot be split counts as PawSpace's own - it never under-declares", async () => {
  /*
   * The conservative direction matters. An invoice with no payout computation behind it cannot be
   * apportioned; counting it as the provider's would understate our own liability, which is the
   * error that attracts a penalty.
   */
  const { sqlite, db, serviceVerticalOutputTax } = await seedInvoices();
  issueInvoice(sqlite, "BK-UNCOSTED", 1180, 180);
  const split = await serviceVerticalOutputTax(db, ...WINDOW);
  assert.equal(split.uncostedTax, 180, "the unsplittable tax must be visible as such");
  assert.equal(split.pawspaceOwnOutputTax, 180, "and counted as ours, not written off to the provider");
  assert.equal(split.providerSupplyGstOnBehalf, 0);
});

test("a cancelled invoice is not taxed, and neither is one outside the period", async () => {
  const { sqlite, db, serviceVerticalOutputTax } = await seedInvoices();
  issueInvoice(sqlite, "BK-LIVE", 1180, 180);
  issueInvoice(sqlite, "BK-CANCELLED", 5000, 900, "cancelled");
  sqlite.prepare("INSERT INTO booking_invoices (id,booking_id,gross_amount,tax_amount,status,issued_at) VALUES (?,?,?,?,'issued',?)")
    .run("INV-LASTMONTH", "BK-LASTMONTH", 9000, 1500, Date.parse("2026-08-15T00:00:00Z"));

  const split = await serviceVerticalOutputTax(db, ...WINDOW);
  assert.equal(split.invoiceCount, 1, "one invoice belongs to this period");
  assert.equal(split.totalTaxCollected, 180, "a cancelled invoice carries no output tax");
});

test("an empty period reports zero rather than failing, and a missing table degrades to zero", async () => {
  const { sqlite, db, serviceVerticalOutputTax } = await seedInvoices();
  const empty = await serviceVerticalOutputTax(db, ...WINDOW);
  assert.equal(empty.totalTaxCollected, 0);
  assert.equal(empty.pawspaceOwnOutputTax, 0);

  sqlite.exec("DROP TABLE booking_invoices");
  const cold = await serviceVerticalOutputTax(db, ...WINDOW);
  assert.equal(cold.totalTaxCollected, 0, "a cold database must not throw inside a statutory close");
  assert.equal(cold.invoiceCount, 0);
});
