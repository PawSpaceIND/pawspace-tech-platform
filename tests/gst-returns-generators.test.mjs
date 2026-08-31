import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// GSTR-1 / GSTR-3B / GSTR-9C portal-return generators (lib/gst-returns.ts). These map the canonical
// tax registers to portal JSON section shapes, fail closed on missing registration config, and never
// file (liveFilingEnabled:false). Tests drive the real module against seeded finance registers.

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

const ENTITY = "pawspace_india", REG = "reg_ka_29", ACTOR = "maker@pawspace.in", CHECKER = "checker@pawspace.in";
const HOME_GSTIN = "29ABCDE1234F1Z5"; // Karnataka (state code 29)
const IST = 330 * 60_000, istMs = (y, m, d) => Date.UTC(y, m - 1, d) - IST;

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db };
  const returns = await import("../lib/gst-returns.ts");
  await returns.ensureGstReturnTables(db); // creates tables + adds finance_invoice_lines.hsn_sac
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_invoices (id TEXT PRIMARY KEY,booking_id TEXT,customer_id TEXT,invoice_number TEXT,status TEXT,currency TEXT,gross_amount REAL,tax_amount REAL,net_amount REAL,issued_at INTEGER,created_at INTEGER,updated_at INTEGER)");
  return { sqlite, db, returns };
}
function activeRegistration(sqlite) {
  sqlite.prepare("INSERT INTO tax_registrations (id,entity_id,jurisdiction,registration_type,registration_reference,status,effective_from,effective_to,approved_by,approved_at,created_at,updated_at) VALUES (?,?,?,?,?,'active',?,?,?,?,?,?)")
    .run(REG, ENTITY, "Karnataka", "gstin", HOME_GSTIN, "2020-01-01", null, "founder", Date.now(), Date.now(), Date.now());
}
function customerProfile(sqlite, id, gstin, type, pos) {
  sqlite.prepare("INSERT INTO finance_customer_tax_profiles (customer_id,registration_reference,customer_type,place_of_supply,status,updated_at) VALUES (?,?,?,?,'active',?)")
    .run(id, gstin, type, pos, Date.now());
}
function invoice(sqlite, { num, customer, issueDate, subtotal, tax, lineTax }) {
  const invId = `inv_${num}`;
  sqlite.prepare("INSERT INTO finance_invoices (id,invoice_number,entity_id,customer_id,source_type,source_id,source_event_key,policy_id,registration_id,issue_date,currency,subtotal,tax_total,total,status,tax_snapshot_json,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'issued',?,?,?)")
    .run(invId, `INV-${num}`, ENTITY, customer, "booking", `src_${num}`, `evt_${num}`, "pol", REG, issueDate, "INR", subtotal, tax, subtotal + tax, "{}", ACTOR, Date.now());
  sqlite.prepare("INSERT INTO finance_invoice_lines (id,invoice_id,line_key,description,service_code,taxable_amount,tax_amount,tax_snapshot_json,hsn_sac) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(`ln_${num}`, invId, "1", lineTax.description, lineTax.serviceCode, subtotal, tax, JSON.stringify({ taxableAmount: subtotal, classificationCode: lineTax.hsn, description: lineTax.description, components: lineTax.components }), lineTax.hsn);
  return invId;
}
function serviceInvoice(sqlite, gross, tax, issuedAt) {
  sqlite.prepare("INSERT INTO booking_invoices (id,booking_id,invoice_number,status,currency,gross_amount,tax_amount,net_amount,issued_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(`bi_${crypto.randomUUID().slice(0, 8)}`, "bk", `GRM-${Math.random()}`, "issued", "INR", gross, tax, gross - tax, issuedAt);
}

test("GSTR-1 splits B2B / B2CS, builds an HSN summary, and reconciles aggregate service supplies", async () => {
  const { sqlite, db, returns } = await world();
  activeRegistration(sqlite);
  customerProfile(sqlite, "cust_b2b", "27AAAAA0000A1Z5", "business", "27"); // Maharashtra -> inter-state
  // B2B inter-state invoice: IGST 18% on 1000 = 180
  invoice(sqlite, { num: "1", customer: "cust_b2b", issueDate: "2026-07-04", subtotal: 1000, tax: 180, lineTax: { description: "Grooming", serviceCode: "grooming", hsn: "999722", components: [{ code: "igst", rate: 18 }] } });
  // B2C intra-state invoice (no profile -> consumer, POS defaults to home 29): CGST+SGST 9+9 on 500
  invoice(sqlite, { num: "2", customer: "cust_b2c", issueDate: "2026-07-09", subtotal: 500, tax: 90, lineTax: { description: "Training", serviceCode: "dog_training", hsn: "999293", components: [{ code: "cgst", rate: 9 }, { code: "sgst", rate: 9 }] } });
  serviceInvoice(sqlite, 590, 90, istMs(2026, 7, 15)); // aggregate-only service supply

  const res = await returns.generateGstr1(db, { entityId: ENTITY, registrationId: REG, periodCode: "2026-07", reason: "monthly gstr1" }, ACTOR);
  assert.equal(res.payload.gstin, HOME_GSTIN);
  assert.equal(res.payload.fp, "072026");
  assert.equal(res.payload.b2b.length, 1);
  assert.equal(res.payload.b2b[0].ctin, "27AAAAA0000A1Z5");
  assert.equal(res.payload.b2b[0].inv[0].itms[0].itm_det.iamt, 180);
  const intra = res.payload.b2cs.find((b) => b.sply_ty === "INTRA" && b.rt === 18);
  assert.ok(intra, "a B2CS intra-state 18% bucket exists");
  assert.equal(intra.camt, 45); assert.equal(intra.samt, 45); assert.equal(intra.txval, 500);
  assert.ok(res.payload.hsn.data.some((h) => h.hsn_sc === "999722"), "HSN summary includes the B2B SAC");
  assert.equal(res.summary.canonicalOutputTax, 270);
  assert.equal(res.summary.serviceVerticalTax, 90);
  assert.equal(res.summary.totalOutputTax, 360);
  assert.equal(res.summary.reconciliation.serviceVerticalTaxExcludedFromSections, 90);
  assert.equal(res.liveFilingEnabled, false);
});

test("GSTR-1 fails closed (ConfigurationRequired) when no active tax registration exists", async () => {
  const { db, returns } = await world(); // no registration seeded
  const { ConfigurationRequired } = await import("../lib/gst-accounting.ts");
  await assert.rejects(
    () => returns.generateGstr1(db, { entityId: ENTITY, registrationId: REG, periodCode: "2026-07" }, ACTOR),
    (e) => e instanceof ConfigurationRequired && e.key === "active_tax_registration",
  );
});

test("GSTR-3B nets two-source output tax against eligible ITC", async () => {
  const { sqlite, db, returns } = await world();
  activeRegistration(sqlite);
  // Ledger output components (B2B): igst 180 + cgst 45 + sgst 45 = 270
  for (const [c, amt] of [["igst", 180], ["cgst", 45], ["sgst", 45]]) {
    sqlite.prepare("INSERT INTO finance_tax_ledger (id,entity_id,registration_id,period_code,component,ledger_type,source_type,source_id,amount,source_event_key,created_at) VALUES (?,?,?,?,?,'output','invoice',?,?,?,?)")
      .run(`txl_${c}`, ENTITY, REG, "2026-07", c, `inv_${c}`, amt, `evt_${c}`, Date.now());
  }
  sqlite.prepare("INSERT INTO finance_invoices (id,invoice_number,entity_id,customer_id,source_type,source_id,source_event_key,policy_id,registration_id,issue_date,currency,subtotal,tax_total,total,status,tax_snapshot_json,created_by,created_at) VALUES ('i','I',?,'c','b','s','e','p',?,'2026-07-05','INR',1500,270,1770,'issued','{}','a',0)").run(ENTITY, REG);
  serviceInvoice(sqlite, 590, 90, istMs(2026, 7, 12)); // service output tax 90
  // Eligible ITC 60 from an approved vendor review (finance_bills already exists via ensureGstAccountingTables)
  sqlite.prepare("INSERT INTO finance_bills (id,vendor_id,bill_number,bill_date,due_date,cost_centre,vertical,taxable_amount,gst_amount,tds_amount,total_amount,status,created_at,updated_at) VALUES ('b1','v1','VB1','2026-07-10','2026-08-10','ops','grooming',333,60,0,393,'approved',0,0)").run();
  sqlite.prepare("INSERT INTO finance_vendor_tax_reviews (id,vendor_id,bill_id,supplier_invoice_number,eligible_tax_amount,review_status,created_at,updated_at) VALUES ('vr1','v1','b1','VB1',60,'eligible',0,0)").run();

  const res = await returns.generateGstr3b(db, { entityId: ENTITY, registrationId: REG, periodCode: "2026-07" }, ACTOR);
  assert.equal(res.summary.outputTaxLedger, 270);
  assert.equal(res.summary.serviceVerticalTax, 90);
  assert.equal(res.summary.totalOutputTax, 360);
  assert.equal(res.summary.eligibleInputTax, 60);
  assert.equal(res.summary.netTaxPayable, 300);
  assert.equal(res.payload.sup_details.osup_det.iamt, 180);
});

test("GSTR-9C reconciles books vs the drafted annual return and flags deltas", async () => {
  const { sqlite, db, returns } = await world();
  activeRegistration(sqlite);
  // Books: canonical FY invoice (taxable 10000, tax 1800) + service (gross 1180 incl tax 180)
  sqlite.prepare("INSERT INTO finance_invoices (id,invoice_number,entity_id,customer_id,source_type,source_id,source_event_key,policy_id,registration_id,issue_date,currency,subtotal,tax_total,total,status,tax_snapshot_json,created_by,created_at) VALUES ('fi','FI',?,'c','b','s','ek','p',?,'2026-09-05','INR',10000,1800,11800,'issued','{}','a',0)").run(ENTITY, REG);
  serviceInvoice(sqlite, 1180, 180, istMs(2026, 9, 20));
  // Annual return summary that MATCHES books output tax (1980) and ITC (0) -> reconciled
  // (finance_annual_returns already exists via ensureGstAccountingTables)
  sqlite.prepare("INSERT INTO finance_annual_returns (id,entity_id,registration_id,financial_year,version,status,summary_json,reconciliation_json,prepared_by,prepared_at) VALUES ('ar',?,?,'2026-27',1,'draft',?,'{}','a',0)")
    .run(ENTITY, REG, JSON.stringify({ totalOutputTax: 1980, totalEligibleItc: 0 }));

  const res = await returns.generateGstr9c(db, { entityId: ENTITY, registrationId: REG, financialYear: "2026" }, ACTOR);
  assert.equal(res.summary.booksOutputTax, 1980, "books = canonical 1800 + service 180");
  assert.equal(res.summary.returnOutputTax, 1980);
  assert.equal(res.summary.outputTaxDelta, 0);
  assert.equal(res.summary.reconciled, true);
});

test("generated returns require maker/checker before review", async () => {
  const { sqlite, db, returns } = await world();
  activeRegistration(sqlite);
  const gen = await returns.generateGstr3b(db, { entityId: ENTITY, registrationId: REG, periodCode: "2026-07" }, ACTOR);
  await assert.rejects(() => returns.approveGstReturn(db, { id: gen.id, approvalReference: "CA-1" }, ACTOR), /maker_checker_required/);
  const approved = await returns.approveGstReturn(db, { id: gen.id, approvalReference: "CA-1" }, CHECKER);
  assert.equal(approved.status, "reviewed");
  assert.equal(approved.liveFilingEnabled, false);
});
