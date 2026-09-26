import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// The confirmed PawSpace commercial/GST/payout model:
//  - commission_standard (boarding/sitting/training/walking): the customer price is GST-INCLUSIVE, so the
//    embedded 18% GST is carved off the top (true inclusive reverse-calc, 18/118) and the GST-exclusive net
//    pool is split. The provider is paid their share of the net pool; PawSpace pays GST on its platform fee
//    only. The carved GST is the PROVIDER's supply GST (-> s52 TCS/GSTR-8), not PawSpace output GST.
//  - funeral_exempt: GST-exempt supply, no GST on the platform fee, vendor paid a share of PawSpace's OWN
//    standard price (not the customer payment).
//  - GST-return generators report PawSpace's OWN output GST (commission only) and disclose the provider-
//    supply GST collected on their behalf separately.

const WORKERS_SHIM = `export const env = new Proxy({}, { get: (_, key) => globalThis.__PAWSPACE_TEST_ENV?.[key] });`;
const workersUrl = `data:text/javascript,${encodeURIComponent(WORKERS_SHIM)}`;
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (e) { if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context); throw e; }
    },
  });
} else {
  const hook = `const workersUrl=${JSON.stringify(workersUrl)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (e) { if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context); throw e; }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...b) => statement(sql, b),
      first: async () => { const r = sqlite.prepare(sql).get(...args); return r === undefined ? null : r; },
      run: async () => { const i = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(i.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return { prepare: (sql) => statement(sql, []), batch: async (list) => { const out = []; for (const s of list) out.push(await s.run()); return out; }, exec: async (sql) => { sqlite.exec(sql); } };
}

const IST = 330 * 60_000, istMs = (y, m, d) => Date.UTC(y, m - 1, d) - IST;
const MAKER = "maker@pawspace.in", CHECKER = "checker@pawspace.in", FINANCE = "finance@pawspace.in";

async function payoutWorld() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db };
  const terms = await import("../lib/provider-commercial-terms.ts");
  await terms.ensureCommercialTermsTables(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,service_code TEXT,provider_id TEXT,total_amount REAL,scheduled_start TEXT,status TEXT)");
  // C3 deliberately treats an unreadable statutory source as a hard failure before replacement DELETEs.
  // These empty source tables make this fixture an explicit successful statutory read, not a missing-table error.
  sqlite.exec("CREATE TABLE IF NOT EXISTS payroll_runs (id TEXT PRIMARY KEY,period_start INTEGER,period_end INTEGER,status TEXT); CREATE TABLE IF NOT EXISTS employee_payroll_results (id TEXT PRIMARY KEY,run_id TEXT,employee_id TEXT,gross_earnings REAL); CREATE TABLE IF NOT EXISTS boarding_host_settlement_ledger (booking_id TEXT,provider_id TEXT,payout_amount REAL,eligible_at INTEGER)");
  return { sqlite, db, terms };
}
async function activate(terms, db, { serviceCode, model, share }) {
  const draft = await terms.saveCommercialTerm(db, { serviceCode, engagementModel: model, providerSharePct: share, effectiveFrom: "2026-01-01", reason: `${serviceCode} ${model} terms`, actorId: MAKER });
  await terms.activateCommercialTerm(db, { termId: draft.id, approvalReference: `${serviceCode.toUpperCase()}-1`, actorId: CHECKER });
}
function booking(sqlite, id, { serviceCode, providerId, amount, start }) {
  sqlite.prepare("INSERT INTO canonical_bookings (id,service_code,provider_id,total_amount,scheduled_start,status) VALUES (?,?,?,?,?,'confirmed')").run(id, serviceCode, providerId, amount, start);
}

test("commission_standard splits a GST-inclusive order true-inclusive: ₹1000 @70% -> provider 593.22, fee 254.24, GST 45.76", async () => {
  const { sqlite, db, terms } = await payoutWorld();
  await activate(terms, db, { serviceCode: "boarding", model: "commission_standard", share: 0.70 });
  booking(sqlite, "BK1", { serviceCode: "boarding", providerId: "P1", amount: 1000, start: "2026-07-10" });

  const p = await terms.computeOrderPayout(db, { bookingId: "BK1", actorId: FINANCE });
  assert.equal(p.engagementModel, "commission_standard");
  assert.equal(p.providerGstDeducted, 0, "owner decision 2 (26 Sept 2026): no GST is taken off the paid amount before the split");
  assert.equal(p.providerGrossShare, 700, "70% of the 1000 the customer paid");
  assert.equal(p.providerNetPayout, 700, "provider is paid their share of the paid amount, no further deduction");
  assert.equal(p.platformFee, 300, "PawSpace commission = the rest of the paid amount");
  assert.equal(p.platformGst, 54, "PawSpace GST on its commission only (18% of 300, the one GST setting's default)");
  assert.equal(p.pawspaceGstOnOrder, 0);
  assert.equal(p.gstExempt, false);
  assert.equal(p.payoutBasis, "full_order");
  // The whole customer GST reconciles: PawSpace's own (45.76) + the provider's supply GST (106.78) = 152.54.
  assert.equal(Math.round((p.platformGst + p.providerGstDeducted) * 100) / 100, 54, "the only GST on the order is PawSpace's 54 on its commission");

  const row = sqlite.prepare("SELECT provider_net_payout,platform_fee,platform_gst,provider_gst_deducted FROM provider_payout_computations WHERE booking_id='BK1'").get();
  assert.equal(Number(row.provider_net_payout), 700);
  assert.equal(Number(row.platform_gst), 54);
  assert.equal(Number(row.provider_gst_deducted), 0);
});

test("commission_groomer keeps the full-order split unchanged (no carve; GST on the fee only)", async () => {
  const { sqlite, db, terms } = await payoutWorld();
  await activate(terms, db, { serviceCode: "grooming", model: "commission_groomer", share: 0.70 });
  booking(sqlite, "BKG", { serviceCode: "grooming", providerId: "G1", amount: 1000, start: "2026-07-10" });

  const p = await terms.computeOrderPayout(db, { bookingId: "BKG", actorId: FINANCE });
  assert.equal(p.providerGstDeducted, 0, "nothing is carved from the groomer's share");
  assert.equal(p.providerNetPayout, 700, "70% of the full order");
  assert.equal(p.platformFee, 300);
  assert.equal(p.platformGst, 54, "PawSpace GST on its 300 fee");
  assert.equal(p.payoutBasis, "full_order");
});

test("funeral_exempt is GST-exempt and pays the vendor a share of PawSpace's OWN standard price", async () => {
  const { sqlite, db, terms } = await payoutWorld();
  await activate(terms, db, { serviceCode: "funeral", model: "funeral_exempt", share: 0.55 });
  // Customer paid a partial ₹8000; PawSpace's own standard price for this service is ₹10000.
  booking(sqlite, "BKF", { serviceCode: "funeral", providerId: "V1", amount: 8000, start: "2026-07-11" });

  const f = await terms.computeOrderPayout(db, { bookingId: "BKF", actorId: FINANCE, standardReferencePrice: 10000 });
  assert.equal(f.gstExempt, true);
  assert.equal(f.platformGst, 0, "no GST on the exempt platform fee");
  assert.equal(f.providerGstDeducted, 0);
  assert.equal(f.pawspaceGstOnOrder, 0);
  assert.equal(f.standardReferencePrice, 10000);
  assert.equal(f.providerNetPayout, 5500, "55% of the ₹10000 standard price, NOT of the ₹8000 collected");
  assert.equal(f.platformFee, 2500, "what PawSpace retains from the collection (8000 - 5500)");
  assert.equal(f.payoutBasis, "standard_price");

  // No standard price supplied -> the vendor share falls back to the customer payment.
  booking(sqlite, "BKF2", { serviceCode: "funeral", providerId: "V1", amount: 8000, start: "2026-07-12" });
  const g = await terms.computeOrderPayout(db, { bookingId: "BKF2", actorId: FINANCE });
  assert.equal(g.standardReferencePrice, 8000);
  assert.equal(g.providerNetPayout, 4400, "55% of the ₹8000 collection when no standard price is set");
  assert.equal(g.platformGst, 0);
});

test("direct_employee carves the embedded GST from the inclusive order (18/118), not 18% on top", async () => {
  const { sqlite, db, terms } = await payoutWorld();
  await activate(terms, db, { serviceCode: "vet_home", model: "direct_employee", share: 0 });
  booking(sqlite, "BKD", { serviceCode: "vet_home", providerId: "E1", amount: 1180, start: "2026-07-10" });

  const d = await terms.computeOrderPayout(db, { bookingId: "BKD", actorId: FINANCE });
  assert.equal(d.directInvoice, true);
  assert.equal(d.pawspaceGstOnOrder, 212.4, "owner decision 3: own-supply GST is 18% of the ₹1180 paid (percent_of_base), not 1180*18/118=180");
  assert.equal(d.platformFee, 967.6, "what PawSpace keeps after its own-supply GST");
  assert.equal(d.platformGst, 0);
  assert.equal(d.providerNetPayout, 0, "no provider payout for a direct employee");
  assert.equal(d.payoutBasis, "full_order");
});

function bookingInvoicesTable(sqlite) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_invoices (id TEXT PRIMARY KEY,booking_id TEXT,customer_id TEXT,invoice_number TEXT,status TEXT,currency TEXT,gross_amount REAL,tax_amount REAL,net_amount REAL,issued_at INTEGER,created_at INTEGER,updated_at INTEGER)");
}

test("statutory package + monthly close count only PawSpace's commission GST as own output for a costed marketplace booking", async () => {
  const { sqlite, db, terms } = await payoutWorld();
  const gst = await import("../lib/gst-accounting.ts");
  const close = await import("../lib/finance-monthly-close.ts");
  await gst.ensureGstAccountingTables(db);
  bookingInvoicesTable(sqlite);
  await activate(terms, db, { serviceCode: "boarding", model: "commission_standard", share: 0.70 });
  booking(sqlite, "BK1", { serviceCode: "boarding", providerId: "P1", amount: 1000, start: "2026-07-10" });
  await terms.computeOrderPayout(db, { bookingId: "BK1", actorId: FINANCE });
  sqlite.prepare("INSERT INTO booking_invoices (id,booking_id,invoice_number,status,currency,gross_amount,tax_amount,net_amount,issued_at) VALUES ('bi1','BK1','GRM-1','issued','INR',1000,152.54,847.46,?)").run(istMs(2026, 7, 10));
  sqlite.prepare("INSERT INTO service_invoice_ownership VALUES ('bi1','pawspace_india','reg_ka_29',?,?,?)").run(MAKER,"Explicit test invoice ownership",Date.now());

  const pkg = await gst.generateStatutoryPackage(db, { entityId: "pawspace_india", registrationId: "reg_ka_29", periodCode: "2026-07", reason: "close" }, MAKER);
  assert.equal(pkg.summary.serviceOutputTax, 54, "owner model: PawSpace files 18% of its 300 commission, from the payout record, not the invoice tax");
  assert.equal(pkg.summary.outputTax, 54, "owner model: 54 on the 300 commission");
  assert.equal(pkg.summary.taxCollectedFromCustomers, 152.54);
  assert.equal(pkg.summary.providerSupplyGstCollectedOnBehalf, 0, "nothing is carved for the provider any more");

  const view = await close.monthlyCloseView(db, { period: "2026-07", actorId: FINANCE });
  assert.equal(view.gst.outputTax, 54, "owner model: matches GSTR-3B, 54 on the 300 commission");
  assert.equal(view.gst.taxCollectedFromCustomers, 152.54);
  assert.equal(view.gst.providerSupplyGstCollectedOnBehalf, 0, "nothing is carved for the provider any more");
  assert.equal(view.gst.netPayable, 54, "no eligible ITC seeded, so net payable = own output");
});

test("GSTR-3B counts only PawSpace's commission GST as output; the provider-supply GST is disclosed for GSTR-8", async () => {
  const { sqlite, db, terms } = await payoutWorld();
  const returns = await import("../lib/gst-returns.ts");
  await returns.ensureGstReturnTables(db);
  const ENTITY = "pawspace_india", REG = "reg_ka_29", GSTIN = "29ABCDE1234F1Z5";
  sqlite.prepare("INSERT INTO tax_registrations (id,entity_id,jurisdiction,registration_type,registration_reference,status,effective_from,effective_to,approved_by,approved_at,created_at,updated_at) VALUES (?,?,?,?,?,'active','2020-01-01',NULL,?,?,?,?)")
    .run(REG, ENTITY, "Karnataka", "gstin", GSTIN, "founder", Date.now(), Date.now(), Date.now());
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_invoices (id TEXT PRIMARY KEY,booking_id TEXT,customer_id TEXT,invoice_number TEXT,status TEXT,currency TEXT,gross_amount REAL,tax_amount REAL,net_amount REAL,issued_at INTEGER,created_at INTEGER,updated_at INTEGER)");

  // A real marketplace commission_standard booking flows through the payout engine (persists platform_gst).
  await activate(terms, db, { serviceCode: "boarding", model: "commission_standard", share: 0.70 });
  booking(sqlite, "BK1", { serviceCode: "boarding", providerId: "P1", amount: 1000, start: "2026-07-10" });
  await terms.computeOrderPayout(db, { bookingId: "BK1", actorId: FINANCE });
  // The customer invoice carries the full inclusive GST (152.54 on a ₹1000 inclusive order).
  sqlite.prepare("INSERT INTO booking_invoices (id,booking_id,invoice_number,status,currency,gross_amount,tax_amount,net_amount,issued_at) VALUES ('bi1','BK1','GRM-1','issued','INR',1000,152.54,847.46,?)").run(istMs(2026, 7, 10));
  sqlite.prepare("INSERT INTO service_invoice_ownership VALUES ('bi1','pawspace_india','reg_ka_29',?,?,?)").run(MAKER,"Explicit test invoice ownership",Date.now());

  const r = await returns.generateGstr3b(db, { entityId: ENTITY, registrationId: REG, periodCode: "2026-07" }, MAKER);
  assert.equal(r.summary.serviceVerticalTax, 54, "owner model: 54 on the 300 commission, from the payout record");
  assert.equal(r.summary.taxCollectedFromCustomers, 152.54, "the full GST collected from the customer is disclosed");
  assert.equal(r.summary.providerSupplyGstCollectedOnBehalf, 0, "nothing is carved for the provider any more");
  assert.equal(r.summary.totalOutputTax, 54, "no B2B ledger output this period");
  assert.equal(r.payload.sup_details.osup_det.txval, 300, "owner model: the taxable value is PawSpace's 300 commission");
  assert.equal(r.liveFilingEnabled, false);
});
