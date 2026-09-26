/*
 * ONE GST setting and ONE GST helper for every PawSpace service (owner decision 1, 26 Sept 2026).
 *
 * The setting holds a rate and a method, effective-dated, audited, per city with an all-cities default:
 *   percent_of_base (default, the owner's choice): GST = 18% x base. Commission 300 -> 54; own supply 1,000 -> 180.
 *   extract_inclusive (if the CA says so):         GST = base x 18/118. Commission 300 -> 45.76; own supply -> 152.54.
 * Every service GST calculation reads it, so switching the method is a Finance action, not a code change.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, attempt, seedActors, asActor } from "./helpers/execution-harness.mjs";

installWorkersHooks("__GST_SETTING_DB__", "__GST_SETTING_ENV__");
const method = await import("../lib/gst-method.ts");
const setting = await import("../lib/gst-setting.ts");
const groomingInvoice = await import("../lib/grooming-invoice.ts");
const terms = await import("../lib/provider-commercial-terms.ts");
const completion = await import("../lib/service-completion-finance.ts");

const PROD_ENV = { NODE_ENV: "production", PAWSPACE_LOCAL_PREVIEW: "off" };
const FINANCE = "finance@pawspace.in", MAKER = "maker@pawspace.in", CHECKER = "checker@pawspace.in";
const TODAY = new Date().toISOString().slice(0, 10);

function settingWorld() {
  const { sqlite, db } = world("__GST_SETTING_DB__", "__GST_SETTING_ENV__", PROD_ENV);
  sqlite.exec(`
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,service_code TEXT,provider_id TEXT,scheduled_start TEXT,status TEXT,total_amount REAL,currency TEXT);
    CREATE TABLE provider_capacity_profiles (id TEXT PRIMARY KEY,provider_model TEXT NOT NULL);
    CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER);
  `);
  return { sqlite, db };
}
function booking(sqlite, id, { service = "grooming", provider = "PRV-1", amount = 1000, date = "2026-09-15", city = "blr" } = {}) {
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,service_code,provider_id,scheduled_start,status,total_amount,currency) VALUES (?,?,?,?,?,?,'completed',?,'INR')").run(id, `CUS-${id}`, city, service, provider, `${date}T05:00:00.000Z`, amount);
  sqlite.prepare("INSERT INTO booking_payments VALUES (?,?,?,?,?,'INR','card','prepaid','captured','razorpay',?,'{}',1,1)").run(`PAY-${id}`, id, `CUS-${id}`, amount, amount, `idem-${id}`);
}
async function activeTerm(db, service, model, share, gstMode) {
  const draft = await terms.saveCommercialTerm(db, { serviceCode: service, engagementModel: model, providerSharePct: share, gstMode, effectiveFrom: "2026-01-01", reason: `${service} setting terms`, actorId: MAKER });
  await terms.activateCommercialTerm(db, { termId: draft.id, approvalReference: `APR-${service}`, actorId: CHECKER });
}
const publish = (db, input) => setting.saveGstSetting(db, { reason: "Confirmed by the CA for FY 26-27", actorId: FINANCE, ...input });

test("the one helper: 18% of the base by default; taken out of a GST-inclusive amount only when that method is chosen", () => {
  const owner = method.DEFAULT_GST_POLICY, inclusive = { ratePercent: 18, method: "extract_inclusive" };
  assert.deepEqual(owner, { ratePercent: 18, method: "percent_of_base" });
  assert.deepEqual([method.gstOn(300, owner), method.gstOn(200, owner), method.gstOn(1000, owner)], [54, 36, 180]);
  assert.deepEqual([method.gstOn(300, inclusive), method.gstOn(200, inclusive), method.gstOn(1000, inclusive)], [45.76, 30.51, 152.54]);
  assert.deepEqual(method.gstBreakdown(300, inclusive), { base: 300, gst: 45.76, taxableValue: 254.24, ratePercent: 18, method: "extract_inclusive" });
  assert.equal(method.gstOn(300, { ratePercent: 0, method: "percent_of_base" }), 0, "a 0% rate is 0, never silently 18%");
  assert.match(String(method.gstPolicyProblem({ ratePercent: 41, method: "percent_of_base" })), /between 0 and 40/);
  assert.match(String(method.gstPolicyProblem({ ratePercent: 18, method: "on_top" })), /percent_of_base or extract_inclusive/);
});

test("with nothing configured every service uses the owner's default: 18% of the base", async () => {
  const { db } = settingWorld();
  const resolved = await setting.resolveGstPolicy(db, { cityId: "blr", atDate: "2026-09-15" });
  assert.deepEqual({ rate: resolved.ratePercent, method: resolved.method, scope: resolved.scope }, { rate: 18, method: "percent_of_base", scope: "built_in_default" });
});

test("Finance switching to extract_inclusive changes every calculation from its effective date: 300 -> 45.76, own supply -> 152.54", async () => {
  const { sqlite, db } = settingWorld();
  await activeTerm(db, "boarding", "commission_standard", 0.70);
  await activeTerm(db, "grooming", "commission_groomer", 0.70);
  await publish(db, { cityId: "*", ratePercent: 18, method: "extract_inclusive", effectiveFrom: "2026-09-01" });
  booking(sqlite, "BK-SEPT", { service: "boarding", provider: "PRV-HOST" });
  booking(sqlite, "BK-AUG", { service: "boarding", provider: "PRV-HOST", date: "2026-08-15" });
  sqlite.prepare("INSERT INTO provider_capacity_profiles VALUES ('PRV-FT','full_time')").run();
  booking(sqlite, "BK-OWN", { service: "grooming", provider: "PRV-FT" });

  const sept = await completion.resolveServiceCompletionFinance(db, { bookingId: "BK-SEPT", actorId: FINANCE });
  assert.deepEqual([sept.providerGrossPayout, sept.platformFee, sept.gstLiability, sept.platformRevenueNetOfGst], [700, 300, 45.76, 254.24]);
  assert.equal(sqlite.prepare("SELECT taxable_commission FROM provider_payout_computations WHERE booking_id='BK-SEPT'").get().taxable_commission, 254.24);
  const own = await completion.resolveServiceCompletionFinance(db, { bookingId: "BK-OWN", actorId: FINANCE });
  assert.deepEqual([own.gstLiability, own.platformRevenueNetOfGst], [152.54, 847.46]);
  const aug = await completion.resolveServiceCompletionFinance(db, { bookingId: "BK-AUG", actorId: FINANCE });
  assert.equal(aug.gstLiability, 54, "a booking dated before the change keeps the rule in force on its date");
});

test("a city's own setting beats the all-cities default, and versions are append-only and audited", async () => {
  const { sqlite, db } = settingWorld();
  await publish(db, { cityId: "*", ratePercent: 18, method: "extract_inclusive", effectiveFrom: "2026-01-01" });
  await publish(db, { cityId: "hyd", ratePercent: 18, method: "percent_of_base", effectiveFrom: "2026-01-01" });
  await publish(db, { cityId: "hyd", ratePercent: 12, method: "percent_of_base", effectiveFrom: "2026-10-01" });
  assert.equal((await setting.resolveGstPolicy(db, { cityId: "blr", atDate: "2026-09-15" })).method, "extract_inclusive");
  const hydSept = await setting.resolveGstPolicy(db, { cityId: "hyd", atDate: "2026-09-15" }), hydOct = await setting.resolveGstPolicy(db, { cityId: "hyd", atDate: "2026-10-15" });
  assert.deepEqual([hydSept.scope, hydSept.method, hydSept.ratePercent, hydOct.ratePercent, hydOct.version], ["city", "percent_of_base", 18, 12, 2]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM gst_setting_versions").get().n, 3, "publishing never edits an earlier version");
  assert.deepEqual({ ...sqlite.prepare("SELECT action,actor_id,reason FROM gst_setting_audit ORDER BY created_at LIMIT 1").get() }, { action: "published", actor_id: FINANCE, reason: "Confirmed by the CA for FY 26-27" });
  for (const [input, message] of [[{ ratePercent: 41, method: "percent_of_base", effectiveFrom: TODAY }, /between 0 and 40/], [{ ratePercent: 18, method: "on_top", effectiveFrom: TODAY }, /GST method/], [{ ratePercent: 18, method: "percent_of_base", effectiveFrom: "2026-13-01" }, /effective-from/], [{ ratePercent: 18, method: "percent_of_base", effectiveFrom: TODAY, reason: "short" }, /reason/]]) {
    const outcome = await attempt(() => publish(db, { cityId: "*", ...input }));
    assert.equal(outcome.status, 400);
    assert.match(outcome.body, message);
  }
});

test("publishing a setting already in force keeps the grooming quote rate in step; a future-dated one leaves quotes alone", async () => {
  const { sqlite, db } = settingWorld();
  await groomingInvoice.ensureGroomingInvoiceTables(db);
  const now = await setting.publishGstSetting(db, { cityId: "*", ratePercent: 12, method: "percent_of_base", effectiveFrom: TODAY, reason: "Owner-approved rate change", actorId: FINANCE });
  assert.deepEqual(now.groomingQuoteCitiesUpdated, ["blr"]);
  assert.deepEqual({ ...sqlite.prepare("SELECT tax_mode,tax_rate,status FROM grooming_tax_policies WHERE city_id='blr'").get() }, { tax_mode: "inclusive", tax_rate: 12, status: "published" }, "quotes still show GST inside the price (owner decision 9), at the one rate");
  const later = await setting.publishGstSetting(db, { cityId: "*", ratePercent: 18, method: "percent_of_base", effectiveFrom: "2099-01-01", reason: "Future rate change", actorId: FINANCE });
  assert.deepEqual(later.groomingQuoteCitiesUpdated, []);
  assert.equal(sqlite.prepare("SELECT tax_rate FROM grooming_tax_policies WHERE city_id='blr'").get().tax_rate, 12);
});

test("the Finance screen's API publishes the setting for finance.manage only, with a reason and an audit event", async () => {
  const { sqlite, db } = settingWorld();
  await seedActors(sqlite, db, [{ id: "U-FIN", email: FINANCE, role: "finance" }, { id: "U-AUD", email: "auditor@pawspace.in", role: "auditor" }]);
  const route = await import("../app/api/grooming-finance/route.ts");
  const body = JSON.stringify({ action: "save_gst_setting", cityId: "*", ratePercent: 18, method: "extract_inclusive", effectiveFrom: "2026-09-01", reason: "CA confirmed prices include GST" });
  const denied = await route.POST(asActor("auditor@pawspace.in", "/api/grooming-finance", { method: "POST", body }));
  assert.equal(denied.status, 403, "read-only finance roles cannot change GST");
  const saved = await route.POST(asActor(FINANCE, "/api/grooming-finance", { method: "POST", body }));
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.deepEqual((({ cityId, ratePercent, method, version }) => ({ cityId, ratePercent, method, version }))((await saved.json()).data), { cityId: "*", ratePercent: 18, method: "extract_inclusive", version: 1 });
  const read = await route.GET(asActor(FINANCE, "/api/grooming-finance?scope=gst_setting"));
  assert.equal((await read.json()).data.platform.method, "extract_inclusive");
  const audit = sqlite.prepare("SELECT actor_email,resource_type,resource_id,outcome FROM security_audit_events WHERE action='finance.gst_setting.published'").get();
  assert.deepEqual({ ...audit }, { actor_email: FINANCE, resource_type: "gst_setting", resource_id: "*", outcome: "completed" });
});
