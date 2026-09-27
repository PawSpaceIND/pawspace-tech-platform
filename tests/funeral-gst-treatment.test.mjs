/*
 * How funeral / memorial is treated for GST (round-3 GST research on top of owner decision A): outside GST under CGST Act
 * Schedule III para 4 by default - GSTR-1 Table 8 non-GST and GSTR-3B 3.1(e), never 3.1(c) - with a Finance setting to switch to
 * "exempt" or "taxable" without code. The setting is effective-dated, audited, idempotent, never starts in a closed month, and
 * is read by other modules through one getter. Driven through the REAL setting, register, GSTR-1, GSTR-3B and GST route.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, attempt, seedActors, asActor } from "./helpers/execution-harness.mjs";

installWorkersHooks("__FUNERAL_GST_DB__", "__FUNERAL_GST_ENV__");
const funeral = await import("../lib/funeral-gst-treatment.ts");
const gstAccounting = await import("../lib/gst-accounting.ts");
const returns = await import("../lib/gst-returns.ts");
const supplies = await import("../lib/service-output-tax.ts");
const funeralOrders = await import("../lib/funeral-manual-order.ts");
const gstRoute = await import("../app/api/gst-accounting/route.ts");

const ENTITY = "pawspace_india", REG = "REG-KA", FINANCE = "finance.staff@pawspace.in", MANAGER = "ops.manager@pawspace.in";
const scope = { entityId: ENTITY, registrationId: REG, periodCode: "2026-09", reason: "September filing" };

async function funeralWorld() {
  const { sqlite, db } = world("__FUNERAL_GST_DB__", "__FUNERAL_GST_ENV__", { NODE_ENV: "production", PAWSPACE_LOCAL_PREVIEW: "off" });
  return { sqlite, db };
}
async function registered(sqlite, db) {
  await gstAccounting.ensureGstAccountingTables(db);
  await returns.ensureGstReturnTables(db);
  sqlite.prepare("INSERT INTO finance_entities (id,legal_name,country_code,status,approved_by,approved_at,created_at,updated_at) VALUES (?,'PawSpace Pvt Ltd','IN','active','founder',1,1,1)").run(ENTITY);
  sqlite.prepare("INSERT INTO tax_registrations (id,entity_id,jurisdiction,registration_type,registration_reference,status,effective_from,effective_to,approved_by,approved_at,created_at,updated_at) VALUES (?,?,'Karnataka','gstin','29AABCP1234A1Z5','active','2020-01-01',NULL,'founder',1,1,1)").run(REG, ENTITY);
}

test("Schedule III is the default; a read never creates a table; the getter resolves the treatment in force on a date", async () => {
  const { sqlite, db } = await funeralWorld();
  const current = await funeral.resolveFuneralGstTreatment(db, "2026-09-20");
  assert.deepEqual([current.treatment, current.source], ["schedule_iii", "default"]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='funeral_gst_treatment_versions'").get().n, 0, "a read creates nothing");
  const saved = await funeral.saveFuneralGstTreatment(db, { treatment: "exempt", effectiveFrom: "2026-10-01", reason: "CA reads pet cremation as exempt", actorId: FINANCE });
  assert.deepEqual([saved.treatment, saved.version, saved.duplicatePrevented], ["exempt", 1, false]);
  assert.equal((await funeral.resolveFuneralGstTreatment(db, "2026-09-30")).treatment, "schedule_iii", "a supply keeps the treatment of its own date");
  assert.deepEqual([(await funeral.resolveFuneralGstTreatment(db, "2026-10-01")).treatment, (await funeral.resolveFuneralGstTreatment(db, "2026-10-01")).source], ["exempt", "setting"]);
  const audit = sqlite.prepare("SELECT action,before_json,after_json,actor_id,reason FROM gst_accounting_audit_events WHERE entity_type='funeral_gst_treatment'").all();
  assert.equal(audit.length, 1);
  assert.deepEqual([JSON.parse(audit[0].before_json).treatment, JSON.parse(audit[0].after_json).treatment, audit[0].actor_id, audit[0].reason], ["schedule_iii", "exempt", FINANCE, "CA reads pet cremation as exempt"]);
  const repeat = await funeral.saveFuneralGstTreatment(db, { treatment: "exempt", effectiveFrom: "2026-10-01", reason: "CA reads pet cremation as exempt", actorId: FINANCE });
  assert.equal(repeat.duplicatePrevented, true, "saving the same change twice is one change");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM funeral_gst_treatment_versions").get().n, 1);
});

test("a change needs a real treatment, date and reason, and never starts in or before a closed month", async () => {
  const { sqlite, db } = await funeralWorld();
  for (const [input, status] of [[{ treatment: "zero_rated", effectiveFrom: "2026-10-01", reason: "Not a treatment at all" }, 400], [{ treatment: "exempt", effectiveFrom: "2026-13-01", reason: "Not a real date here" }, 400], [{ treatment: "exempt", effectiveFrom: "2026-10-01", reason: "short" }, 400]]) {
    const refused = await attempt(() => funeral.saveFuneralGstTreatment(db, { ...input, actorId: FINANCE }));
    assert.equal(refused.status, status, JSON.stringify(input));
  }
  await registered(sqlite, db);
  sqlite.prepare("INSERT INTO finance_close_periods (period_code,status,checklist_json,locked_at,locked_by,updated_at) VALUES ('2026-09','locked','{}',1,'finance',1)").run();
  const closed = await attempt(() => funeral.saveFuneralGstTreatment(db, { treatment: "taxable_18", effectiveFrom: "2026-08-15", reason: "Back-dated into a closed month", actorId: FINANCE }));
  assert.equal(closed.status, 409);
  assert.match(closed.body, /2026-09 is closed and locked/);
  const fine = await funeral.saveFuneralGstTreatment(db, { treatment: "taxable_18", effectiveFrom: "2026-10-01", reason: "From the next open month", actorId: FINANCE });
  assert.equal(fine.version, 1);
});

test("the returns file funeral outside GST (3.1(e)) by default and exempt (3.1(c)) once Finance switches", async () => {
  const { sqlite, db } = await funeralWorld();
  await registered(sqlite, db);
  await funeralOrders.recordFuneralConvertedOrder(db, { customerName: "Asha", phone: "9000000000", paymentMethod: "upi", orderValue: 5000, orderDate: "2026-09-20", actorId: FINANCE });
  await supplies.assignPeriodServiceOwnership(db, { periodCode: "2026-09", entityId: ENTITY, registrationId: REG, reason: "PawSpace India files its funeral orders" }, FINANCE);
  let gstr1 = await returns.generateGstr1(db, scope, "maker@pawspace.in");
  let gstr3b = await returns.generateGstr3b(db, scope, "maker@pawspace.in");
  assert.deepEqual(gstr1.payload.nil.inv, [{ sply_ty: "INTRAB2C", expt_amt: 0, nil_amt: 0, ngsup_amt: 5000 }]);
  assert.deepEqual([gstr3b.payload.sup_details.osup_nongst, gstr3b.payload.sup_details.osup_nil_exmp], [{ txval: 5000 }, { txval: 0 }]);
  assert.equal(gstr1.payload.hsn.data.length, 0, "a Schedule III activity is not a supply for the HSN summary");

  await funeral.saveFuneralGstTreatment(db, { treatment: "exempt", effectiveFrom: "2026-09-01", reason: "CA reads pet cremation as exempt", actorId: FINANCE });
  gstr1 = await returns.generateGstr1(db, scope, "maker@pawspace.in");
  gstr3b = await returns.generateGstr3b(db, scope, "maker@pawspace.in");
  assert.deepEqual(gstr1.payload.nil.inv, [{ sply_ty: "INTRAB2C", expt_amt: 5000, nil_amt: 0, ngsup_amt: 0 }]);
  assert.deepEqual([gstr3b.payload.sup_details.osup_nongst, gstr3b.payload.sup_details.osup_nil_exmp], [{ txval: 0 }, { txval: 5000 }]);
  assert.deepEqual(gstr1.payload.hsn.data.map((h) => [h.hsn_sc, h.txval, h.camt]), [["999731", 5000, 0]]);
});

test("only finance.manage changes the treatment through the GST route", async () => {
  const { sqlite, db } = await funeralWorld();
  await registered(sqlite, db);
  await seedActors(sqlite, db, [{ id: "USR-FIN", email: FINANCE, role: "finance" }, { id: "USR-MGR", email: MANAGER, role: "manager" }]);
  const post = (email) => gstRoute.POST(asActor(email, "/api/gst-accounting", { method: "POST", body: JSON.stringify({ action: "save_funeral_gst_treatment", treatment: "exempt", effectiveFrom: "2026-12-01", reason: "CA reads pet cremation as exempt" }) }));
  assert.equal((await post(MANAGER)).status, 403);
  const saved = await post(FINANCE);
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.equal((await saved.json()).data.treatment, "exempt");
});
