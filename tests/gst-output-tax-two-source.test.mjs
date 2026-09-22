import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// The monthly statutory package (GSTR-3B) and the annual return (GSTR-9) historically summed output
// tax from finance_tax_ledger ONLY. That table is written solely by the B2B invoice path; the five
// service verticals (grooming/boarding/sitting/walking/taxi) write their tax into
// booking_invoices.tax_amount. Reading one source made output GST structurally understated for the
// entire service business. These tests pin the two-source roll-up now in lib/gst-accounting.ts and
// that it still degrades to the ledger-only figure (never a 500) when booking_invoices is absent.

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

const ENTITY = "pawspace_india", REG = "reg_ka_29", PERIOD = "2026-07", ACTOR = "maker@pawspace.in";
const IST = 330 * 60_000;
const istMs = (y, m, d) => Date.UTC(y, m - 1, d) - IST; // an epoch-ms instant inside the IST month

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db };
  const gst = await import("../lib/gst-accounting.ts");
  await gst.ensureGstAccountingTables(db);
  return { sqlite, db, gst };
}
function seedLedgerOutput(sqlite, amount, component = "igst") {
  sqlite.prepare("INSERT INTO finance_tax_ledger (id,entity_id,registration_id,period_code,component,ledger_type,source_type,source_id,amount,source_event_key,created_at) VALUES (?,?,?,?,?,'output','invoice',?,?,?,?)")
    .run(`txl_${component}`, ENTITY, REG, PERIOD, component, `inv_${component}`, amount, `evt_${component}`, Date.now());
}
function createBookingInvoices(sqlite) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_invoices (id TEXT PRIMARY KEY,booking_id TEXT,customer_id TEXT,invoice_number TEXT,status TEXT,currency TEXT,gross_amount REAL,tax_amount REAL,net_amount REAL,issued_at INTEGER,created_at INTEGER,updated_at INTEGER)");
}
function seedServiceInvoice(sqlite, tax, issuedAt, status = "issued") {
  const invoiceId=`bi_${crypto.randomUUID().slice(0, 8)}`;
  sqlite.prepare("INSERT INTO service_invoice_ownership VALUES (?,?,?,?,?,?)").run(invoiceId,ENTITY,REG,ACTOR,"Explicit test invoice owner",Date.now());
  sqlite.prepare("INSERT INTO booking_invoices (id,booking_id,invoice_number,status,currency,gross_amount,tax_amount,net_amount,issued_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(invoiceId, `bk_${crypto.randomUUID().slice(0, 6)}`, `GRM-${Math.random()}`, status, "INR", tax * 6, tax, tax * 5, issuedAt);
}

test("GSTR-3B monthly package sums ledger output + service booking-invoice tax", async () => {
  const { sqlite, db, gst } = await world();
  createBookingInvoices(sqlite);
  seedLedgerOutput(sqlite, 1000);                       // B2B output tax
  seedServiceInvoice(sqlite, 360, istMs(2026, 7, 15));  // in-month service tax
  seedServiceInvoice(sqlite, 90, istMs(2026, 6, 20));   // prior month — must NOT count
  seedServiceInvoice(sqlite, 50, istMs(2026, 7, 18), "cancelled"); // cancelled — must NOT count
  const res = await gst.generateStatutoryPackage(db, { entityId: ENTITY, registrationId: REG, periodCode: PERIOD, reason: "monthly close" }, ACTOR);
  assert.equal(res.summary.ledgerOutputTax, 1000);
  assert.equal(res.summary.serviceOutputTax, 360);
  assert.equal(res.summary.outputTax, 1360, "output tax must be the two-source sum");
});

test("GSTR-9 annual return folds service output tax into the total and the month bucket", async () => {
  const { sqlite, db, gst } = await world();
  createBookingInvoices(sqlite);
  seedLedgerOutput(sqlite, 1000);
  seedServiceInvoice(sqlite, 360, istMs(2026, 7, 15));
  const res = await gst.generateAnnualReturn(db, { entityId: ENTITY, registrationId: REG, financialYear: "2026", reason: "annual" }, ACTOR);
  assert.equal(res.summary.ledgerOutputTax, 1000);
  assert.equal(res.summary.serviceOutputTax, 360);
  assert.equal(res.summary.totalOutputTax, 1360, "FY output tax must include service verticals");
  assert.equal(res.summary.monthlyOutputTax["2026-07"], 1360, "the month bucket must include service tax");
});

test("output-tax roll-up degrades to ledger-only when booking_invoices is absent (no 500)", async () => {
  const { sqlite, db, gst } = await world(); // booking_invoices intentionally not created
  seedLedgerOutput(sqlite, 720);
  const res = await gst.generateStatutoryPackage(db, { entityId: ENTITY, registrationId: REG, periodCode: PERIOD, reason: "monthly close" }, ACTOR);
  assert.equal(res.summary.serviceOutputTax, 0);
  assert.equal(res.summary.outputTax, 720);
});

test('statutory service output stays isolated by entity and registration',async()=>{
 const {sqlite,db,gst}=await world();createBookingInvoices(sqlite);
 seedServiceInvoice(sqlite,360,istMs(2026,7,15));
 const otherInvoice='OTHER-INVOICE';
 sqlite.prepare("INSERT INTO booking_invoices(id,booking_id,status,gross_amount,tax_amount,issued_at) VALUES(?,?,'issued',118,18,?)").run(otherInvoice,'OTHER-BOOKING',istMs(2026,7,15));
 sqlite.prepare('INSERT INTO service_invoice_ownership VALUES(?,?,?,?,?,?)').run(otherInvoice,'OTHER-ENTITY','OTHER-REG',ACTOR,'Other entity invoice',Date.now());
 const first=await gst.generateStatutoryPackage(db,{entityId:ENTITY,registrationId:REG,periodCode:PERIOD},ACTOR);
 const other=await gst.generateStatutoryPackage(db,{entityId:'OTHER-ENTITY',registrationId:'OTHER-REG',periodCode:PERIOD},ACTOR);
 assert.equal(first.summary.serviceOutputTax,360);assert.equal(first.summary.serviceInvoiceCount,1);
 assert.equal(other.summary.serviceOutputTax,18);assert.equal(other.summary.serviceInvoiceCount,1);
 const wrongRegistration=await gst.generateStatutoryPackage(db,{entityId:ENTITY,registrationId:'OTHER-REG',periodCode:PERIOD},ACTOR);
 assert.equal(wrongRegistration.summary.serviceOutputTax,0);
});
test('unassigned service invoices block statutory generation instead of appearing in every entity',async()=>{
 const {sqlite,db,gst}=await world();createBookingInvoices(sqlite);
 sqlite.prepare("INSERT INTO booking_invoices(id,booking_id,status,gross_amount,tax_amount,issued_at) VALUES('UNASSIGNED','B','issued',118,18,?)").run(istMs(2026,7,15));
 await assert.rejects(gst.generateStatutoryPackage(db,{entityId:ENTITY,registrationId:REG,periodCode:PERIOD},ACTOR),/Assign each service invoice/);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM finance_statutory_packages').get().n,0);
});

test('invoice assignment is immutable, entity scoped and refused for a locked period',async()=>{
 const{sqlite,db}=await world();createBookingInvoices(sqlite);
 const{assignServiceInvoiceOwnership}=await import('../lib/service-invoice-ownership.ts');
 sqlite.exec("INSERT INTO finance_entities VALUES ('E1','Test Entity','IN','active','qa',1,1,1);INSERT INTO tax_registrations VALUES ('R1','E1','KA','gstin','TESTONLY','active','2026-01-01',NULL,'qa',1,1,1)");
 sqlite.prepare("INSERT INTO booking_invoices (id,booking_id,invoice_number,status,issued_at) VALUES ('I1','B1','QA-1','issued',?)").run(istMs(2026,7,15));
 const input={invoiceId:'I1',entityId:'E1',registrationId:'R1',reason:'Synthetic invoice assignment'};
 const rejectStatus=status=>error=>error instanceof Response&&error.status===status;
 await assert.rejects(assignServiceInvoiceOwnership(db,{...input,entityId:'OTHER'},ACTOR),rejectStatus(409));
 await assignServiceInvoiceOwnership(db,input,ACTOR);await assignServiceInvoiceOwnership(db,input,ACTOR);
 assert.equal(sqlite.prepare("SELECT count(*) n FROM service_invoice_ownership WHERE invoice_id='I1'").get().n,1);
 sqlite.exec("INSERT INTO finance_close_periods VALUES ('2026-07','locked','{}',1,'checker',1)");
 await assert.rejects(assignServiceInvoiceOwnership(db,input,ACTOR),rejectStatus(409));
});
