/*
 * The customer tax invoice for a completed booking (owner decision B, 27 Sept 2026), driven through the REAL completion path.
 *
 * The seller named in the active tax policy's seller JSON - staging seeds TK PETCARE SOLUTIONS PRIVATE LIMITED under entity
 * SEEDFE-TKPET - issues one invoice per completed booking at completion, through lib/statutory-invoicing.ts: idempotent per
 * booking, one financial-year series of at most 16 characters that rolls over by itself, the document showing what the
 * customer paid split the owner's way (decision A), and plain configuration_required refusals that never block a completion.
 *
 * Before this change nothing issued a customer invoice at completion: finance_invoices held only what Finance typed by hand,
 * with tax added on top (subtotal + tax), so a Rs 1,000 own-supply booking would have read Rs 1,180.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, attempt } from "./helpers/execution-harness.mjs";

installWorkersHooks("__BOOKING_INVOICE_DB__", "__BOOKING_INVOICE_ENV__");
const terms = await import("../lib/provider-commercial-terms.ts");
const completion = await import("../lib/service-completion-finance.ts");
const gstAccounting = await import("../lib/gst-accounting.ts");
const returns = await import("../lib/gst-returns.ts");
const invoices = await import("../lib/booking-tax-invoice.ts");
const funeral = await import("../lib/funeral-gst-treatment.ts");
const statutory = await import("../lib/statutory-invoicing.ts");

const PROD_ENV = { NODE_ENV: "production", PAWSPACE_LOCAL_PREVIEW: "off" };
const ENTITY = "SEEDFE-TKPET", REG = "SEEDTR-TKPET-KA", POLICY = "SEEDTP-TKPET-1", GSTIN = "29AAICT7352F1Z0";
const SELLER = { legalName: "TK PETCARE SOLUTIONS PRIVATE LIMITED", gstin: GSTIN, stateCode: "29", state: "Karnataka", address: "2nd Floor, Kokarya Business Synergy Center, Jayanagar 9th Block, Bengaluru, Karnataka 560041" };
const MAKER = "maker@pawspace.in", CHECKER = "checker@pawspace.in", FINANCE = "finance@pawspace.in";
const IST = 330 * 60_000, DAY = 86_400_000;
const istDay = (ms) => new Date(ms + IST).toISOString().slice(0, 10);
// Completions happen "now", so the 30-day invoice window (Rule 47) holds whenever the suite runs.
const NOW = Date.now(), TODAY = istDay(NOW);
const fyShort = (date) => { const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7)), s = m >= 4 ? y : y - 1; return `${String(s % 100).padStart(2, "0")}-${String((s + 1) % 100).padStart(2, "0")}`; };

async function invoiceWorld({ seller = SELLER, registration = true, series = "TKP/{FY}/", inclusive = true } = {}) {
  const { sqlite, db } = world("__BOOKING_INVOICE_DB__", "__BOOKING_INVOICE_ENV__", PROD_ENV);
  sqlite.exec(`
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,pet_ids_json TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,total_amount REAL,currency TEXT,pricing_json TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE canonical_customers (id TEXT PRIMARY KEY,city_id TEXT,name TEXT,primary_phone TEXT);
    CREATE TABLE canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT,name TEXT,species TEXT);
    CREATE TABLE booking_service_addresses (booking_id TEXT PRIMARY KEY,address TEXT NOT NULL,latitude REAL,longitude REAL,source TEXT NOT NULL DEFAULT 'staff_entered',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE provider_capacity_profiles (id TEXT PRIMARY KEY,name TEXT,provider_model TEXT NOT NULL);
    CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER);
  `);
  await gstAccounting.ensureGstAccountingTables(db);
  await returns.ensureGstReturnTables(db);
  sqlite.prepare("INSERT INTO finance_entities (id,legal_name,country_code,status,approved_by,approved_at,created_at,updated_at) VALUES (?,?,'IN','active','founder',1,1,1)").run(ENTITY, SELLER.legalName);
  if (registration) sqlite.prepare("INSERT INTO tax_registrations (id,entity_id,jurisdiction,registration_type,registration_reference,status,effective_from,effective_to,approved_by,approved_at,created_at,updated_at) VALUES (?,?,'IN-KA','gstin',?,'active','2024-01-01',NULL,'founder',1,1,1)").run(REG, ENTITY, GSTIN);
  sqlite.prepare("INSERT INTO tax_policy_versions (id,entity_id,version,status,effective_from,effective_to,policy_json,approval_reference,approved_by,approved_at,created_at,updated_at) VALUES (?,?,1,'active','2024-01-01',NULL,?,'SEED-GST-APPROVAL','founder',1,1,1)")
    .run(POLICY, ENTITY, JSON.stringify({ ...(seller ? { seller } : {}), defaultComponents: [{ code: "CGST", rate: 9 }, { code: "SGST", rate: 9 }] }));
  if (series) sqlite.prepare("INSERT INTO finance_document_series (id,entity_id,document_type,prefix,next_number,padding,policy_id,status,updated_at) VALUES ('SERIES-TKP',?,'invoice',?,1,5,?,'active',1)").run(ENTITY, series, POLICY);
  if(inclusive){const {saveGstSetting}=await import("../lib/gst-setting.ts");await saveGstSetting(db,{cityId:"*",ratePercent:18,method:"extract_inclusive",effectiveFrom:"2024-01-01",reason:"Owner approved inclusive customer total invoice fixture",actorId:FINANCE});}
  return { sqlite, db };
}
async function activeTerm(db, { service, model = "commission_standard", share = 0.70 }) {
  const draft = await terms.saveCommercialTerm(db, { serviceCode: service, engagementModel: model, providerSharePct: share, effectiveFrom: "2024-01-01", reason: `${service} owner model terms`, actorId: MAKER });
  await terms.activateCommercialTerm(db, { termId: draft.id, approvalReference: `APR-${service}`, actorId: CHECKER });
}
function booking(sqlite, id, { service = "grooming", provider = "PRV-G", amount = 1000, city = "blr", customer = `CUS-${id}`, pets = [], addOns = [] } = {}) {
  const start = new Date(NOW - 2 * 3600_000).toISOString();
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,pet_ids_json,city_id,zone_id,service_code,package_code,package_name,provider_id,scheduled_start,scheduled_end,status,total_amount,currency,pricing_json,created_at,updated_at) VALUES (?,?,?,?,?,?,'pkg','Full groom',?,?,?,'completed',?,'INR',?,1,1)")
    .run(id, customer, JSON.stringify(pets.map(([petId]) => petId)), city, `${city}-east`, service, provider, start, start, amount, JSON.stringify({ addOns }));
  for (const [petId, name] of pets) sqlite.prepare("INSERT OR IGNORE INTO canonical_pets VALUES (?,?,?,'dog')").run(petId, customer, name);
  sqlite.prepare("INSERT OR IGNORE INTO canonical_customers VALUES (?,?,?,?)").run(customer, city, "Asha Rao", "9000000001");
  sqlite.prepare("INSERT INTO booking_service_addresses (booking_id,address,created_at,updated_at) VALUES (?,?,1,1)").run(id, "12 Park Road, Jayanagar, Bengaluru 560041");
  sqlite.prepare("INSERT INTO booking_payments VALUES (?,?,?,?,?,'INR','upi','prepaid','captured','razorpay',?,'{}',1,1)").run(`PAY-${id}`, id, customer, amount, amount, `idem-${id}`);
}
const complete = (db, bookingId, completedAt = NOW) => completion.resolveServiceCompletionFinance(db, { bookingId, actorId: FINANCE, completedAt });
const invoiceRows = (sqlite) => sqlite.prepare("SELECT * FROM finance_invoices ORDER BY created_at,rowid").all();
const linesOf = (sqlite, invoiceId) => sqlite.prepare("SELECT line_key,taxable_amount,tax_amount,tax_snapshot_json FROM finance_invoice_lines WHERE invoice_id=? ORDER BY rowid").all(invoiceId).map((l) => ({ ...l, snap: JSON.parse(l.tax_snapshot_json) }));

test("completion issues exactly one tax invoice from the seller in the policy; a retry returns it; the number fits 16 characters", async () => {
  const { sqlite, db } = await invoiceWorld();
  await activeTerm(db, { service: "grooming", model: "commission_groomer" });
  sqlite.prepare("INSERT INTO provider_capacity_profiles VALUES ('PRV-G','Priya',  'commission')").run();
  booking(sqlite, "BK-GROOM", { pets: [["PET-1", "Bruno"]], addOns: ["Nail trim"] });
  const fact = await complete(db, "BK-GROOM");
  assert.equal(fact.gstLiability, 45.76, "the books are unchanged: 54 on the 300 commission");

  let rows = invoiceRows(sqlite);
  assert.equal(rows.length, 1, "one invoice at completion");
  const invoice = rows[0];
  assert.equal(invoice.invoice_number, `TKP/${fyShort(TODAY)}/00001`);
  assert.ok(invoice.invoice_number.length <= 16, "Rule 46(b): at most 16 characters");
  assert.equal(invoice.invoice_number.length, 15);
  assert.deepEqual([invoice.entity_id, invoice.registration_id, invoice.source_type, invoice.source_id, invoice.source_event_key, invoice.issue_date], [ENTITY, REG, "booking", "BK-GROOM", "booking-invoice:BK-GROOM", istDay(NOW)]);

  // Retries (a second capture of the same completion, a read-model refresh) return the same invoice and burn no serial.
  await complete(db, "BK-GROOM");
  const again = await invoices.issueBookingInvoice(db, { bookingId: "BK-GROOM", actorId: FINANCE });
  assert.deepEqual([again.status, again.invoiceNumber], ["existing", invoice.invoice_number]);
  rows = invoiceRows(sqlite);
  assert.equal(rows.length, 1, "still exactly one invoice");
  assert.equal(sqlite.prepare("SELECT next_number FROM finance_document_series_v2").get().next_number, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM finance_invoice_serial_claims").get().n, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM gst_accounting_audit_events WHERE entity_type='invoice' AND action='issued_statutory'").get().n, 1, "the issue is audited once");
  // Its tax is filed through the service supply register, so its ledger rows stay out of the canonical "output" sums.
  assert.deepEqual(sqlite.prepare("SELECT DISTINCT ledger_type FROM finance_tax_ledger").all().map((r) => r.ledger_type), ["booking_output"]);
});

test("a commission booking shows the provider's charges collected on their behalf and PawSpace's fee as the only taxable line", async () => {
  const { sqlite, db } = await invoiceWorld();
  await activeTerm(db, { service: "grooming", model: "commission_groomer" });
  sqlite.prepare("INSERT INTO provider_capacity_profiles VALUES ('PRV-G','Priya','commission')").run();
  booking(sqlite, "BK-COMM", { pets: [["PET-1", "Bruno"]], addOns: ["Nail trim"] });
  await complete(db, "BK-COMM");
  const [invoice] = invoiceRows(sqlite);
  assert.deepEqual([invoice.subtotal, invoice.tax_total, invoice.amount_received, invoice.total, invoice.document_kind], [254.24, 45.76, 1000, 1000, "tax_invoice"], "provider700 plus taxable254.24 plus GST45.76 reconcile to the approved customer total");
  const [provider, fee] = linesOf(sqlite, invoice.id);
  assert.equal(provider.snap.role, "collected_on_behalf");
  assert.equal(provider.snap.description, "Grooming by Priya: charges collected on the provider's behalf");
  assert.deepEqual([provider.snap.lineAmount, provider.taxable_amount, provider.tax_amount, provider.snap.classificationCode], [700, 0, 0, null], "700, no SAC, no GST, not part of the taxable value");
  assert.deepEqual([fee.snap.description, fee.snap.classificationCode, fee.snap.lineAmount, fee.taxable_amount, fee.tax_amount], ["PawSpace platform and service fee", "998599", 300, 254.24, 45.76]);
  assert.deepEqual(fee.snap.components, [{ code: "CGST", rate: 9, amount: 22.88 }, { code: "SGST", rate: 9, amount: 22.88 }], "Karnataka: CGST 9% + SGST 9%");
  assert.equal(fee.snap.pos_rule, "default_recipient_or_service", "the place-of-supply rule used is recorded on the line");

  const doc = await invoices.bookingInvoiceDocument(db, "BK-COMM");
  assert.equal(doc.title, "Tax invoice");
  assert.deepEqual([doc.taxableValue, doc.cgst, doc.sgst, doc.igst, doc.totalTax, doc.collectedOnBehalf, doc.amountReceived], [254.24, 22.88, 22.88, 0, 45.76, 700, 1000]);
  assert.deepEqual(doc.placeOfSupply, { code: "29", name: "Karnataka", rule: "default_recipient_or_service" });
  assert.deepEqual([doc.buyer.name, doc.buyer.state, doc.buyer.stateCode], ["Asha Rao", "Karnataka", "29"]);
  assert.equal(doc.amountInWords, "Rupees One Thousand Only");
  assert.ok(doc.notes.includes(`GST is included in the amount paid and is paid to the government by ${SELLER.legalName}.`));

  // Rule 46: the printable page carries every particular, the customer's state (proviso to Rule 46(f)) and no invented seller.
  const html = invoices.renderBookingInvoiceHtml(doc);
  for (const field of [SELLER.legalName, SELLER.address, `GSTIN: ${GSTIN}`, "State: Karnataka (29)", doc.invoiceNumber, "Place of supply: Karnataka (29)", "Customer state: Karnataka (29)", "Asha Rao", "12 Park Road, Jayanagar, Bengaluru 560041", "Phone: 9000000001", "998599", "Other support services n.e.c.", "Tax payable on reverse charge: No", "Rupees One Thousand Only", "₹1,000.00", "₹300.00", "₹22.88", "This is a computer-generated tax invoice.", "Authorised signatory", "Pets: Bruno", "Add-ons: Nail trim"])
    assert.ok(html.includes(field), `the invoice shows ${field}`);
  assert.equal(html.includes("₹1,054.00"), false, "the customer is never shown subtotal + tax");
});

test("an own supply files one line of the full amount paid, CGST + SGST in Karnataka and IGST for another state", async () => {
  const { sqlite, db } = await invoiceWorld();
  await activeTerm(db, { service: "grooming", model: "commission_groomer" });
  sqlite.prepare("INSERT INTO provider_capacity_profiles VALUES ('PRV-FT','Ravi','full_time')").run();
  booking(sqlite, "BK-OWN", { provider: "PRV-FT" });
  booking(sqlite, "BK-OWN-HYD", { provider: "PRV-FT", city: "hyd" });
  assert.equal((await complete(db, "BK-OWN")).gstLiability, 152.54);
  await complete(db, "BK-OWN-HYD");
  const [blr, hyd] = invoiceRows(sqlite);
  assert.deepEqual([blr.subtotal, blr.tax_total, blr.amount_received], [847.46, 152.54, 1000], "taxable847.46 plus GST152.54 reconcile to customer total1000");
  const [line] = linesOf(sqlite, blr.id);
  assert.deepEqual([line.snap.role, line.snap.classificationCode, line.snap.lineAmount, line.taxable_amount, line.tax_amount], ["taxable", "998612", 1000, 847.46, 152.54]);
  assert.match(line.snap.description, /^Grooming: Full groom on /, "the service, its package and date");
  assert.deepEqual(line.snap.components, [{ code: "CGST", rate: 9, amount: 76.27 }, { code: "SGST", rate: 9, amount: 76.27 }]);
  const hydLine = linesOf(sqlite, hyd.id)[0];
  assert.deepEqual(hydLine.snap.components, [{ code: "IGST", rate: 18, amount: 152.54 }], "performed in Telangana: IGST 18% from the Karnataka registration");
  const hydDoc = await invoices.bookingInvoiceDocument(db, "BK-OWN-HYD");
  assert.deepEqual([hydDoc.placeOfSupply.name, hydDoc.buyer.state, hydDoc.igst, hydDoc.supplyType], ["Telangana", "Telangana", 152.54, "inter"]);
  assert.ok(invoices.renderBookingInvoiceHtml(hydDoc).includes("Customer state: Telangana (36)"));
  const doc = await invoices.bookingInvoiceDocument(db, "BK-OWN");
  assert.ok(invoices.renderBookingInvoiceHtml(doc).includes("Animal husbandry services"), "the official SAC description is printed");
});

test("funeral is a bill of supply: outside GST (Schedule III) by default, exempt when Finance switches, and never taxed silently", async () => {
  const { sqlite, db } = await invoiceWorld();
  await activeTerm(db, { service: "funeral_memorial" });
  booking(sqlite, "BK-FUN", { service: "funeral_memorial", provider: "PRV-VENDOR" });
  assert.equal((await complete(db, "BK-FUN")).gstLiability, 0);
  const [invoice] = invoiceRows(sqlite);
  assert.deepEqual([invoice.document_kind, invoice.subtotal, invoice.tax_total, invoice.amount_received], ["bill_of_supply", 0, 0, 1000]);
  const [provider, fee] = linesOf(sqlite, invoice.id);
  assert.deepEqual([provider.snap.role, provider.snap.lineAmount], ["collected_on_behalf", 700]);
  assert.deepEqual([fee.snap.role, fee.snap.classificationCode, fee.snap.exemptValue, fee.tax_amount, fee.snap.components], ["non_gst", "999731", 300, 0, []]);
  const doc = await invoices.bookingInvoiceDocument(db, "BK-FUN");
  assert.equal(doc.title, "Bill of supply");
  assert.equal(doc.nonGstValue, 300);
  assert.ok(doc.notes.some((note) => note.includes("Schedule III, para 4")));
  const html = invoices.renderBookingInvoiceHtml(doc);
  assert.equal(html.includes("CGST @"), false, "no tax lines on a bill of supply");
  assert.ok(html.includes("This is a computer-generated bill of supply."));

  await funeral.saveFuneralGstTreatment(db, { treatment: "exempt", effectiveFrom: "2024-01-01", reason: "CA reads funeral as exempt", actorId: FINANCE });
  booking(sqlite, "BK-FUN-2", { service: "funeral_memorial", provider: "PRV-VENDOR" });
  await complete(db, "BK-FUN-2");
  const second = invoiceRows(sqlite)[1];
  assert.equal(linesOf(sqlite, second.id)[1].snap.role, "exempt");
  assert.ok((await invoices.bookingInvoiceDocument(db, "BK-FUN-2")).notes.includes("Exempt supply: no GST is charged."));

  // Taxable: the payout engine charges GST on the amount PawSpace makes, and the invoice shows it.
  await funeral.saveFuneralGstTreatment(db, { treatment: "taxable_18", effectiveFrom: "2024-01-02", reason: "CA reads funeral as taxable", actorId: FINANCE });
  booking(sqlite, "BK-FUN-3", { service: "funeral_memorial", provider: "PRV-VENDOR" });
  assert.equal((await complete(db, "BK-FUN-3")).gstLiability, 45.76);
  const third = invoiceRows(sqlite)[2];
  assert.deepEqual([third.document_kind, third.subtotal, third.tax_total], ["tax_invoice", 254.24, 45.76]);
});

test("the FY series rolls over by itself: 31 March and 1 April get different series, each starting at 00001", async () => {
  const { sqlite, db } = await invoiceWorld();
  await activeTerm(db, { service: "grooming", model: "commission_groomer" });
  sqlite.prepare("INSERT INTO provider_capacity_profiles VALUES ('PRV-FT','Ravi','full_time')").run();
  const march = Date.parse("2026-03-31T18:00:00+05:30"), april = Date.parse("2026-04-01T10:00:00+05:30");
  booking(sqlite, "BK-MAR", { provider: "PRV-FT" });
  booking(sqlite, "BK-APR", { provider: "PRV-FT" });
  await complete(db, "BK-MAR", march);
  await complete(db, "BK-APR", april);
  assert.equal(invoiceRows(sqlite).length, 0, "completed months ago: more than 30 days, so completion today issues nothing (Rule 47)");
  const first = await invoices.issueBookingInvoice(db, { bookingId: "BK-MAR", actorId: FINANCE, asOf: march + DAY });
  const second = await invoices.issueBookingInvoice(db, { bookingId: "BK-APR", actorId: FINANCE, asOf: april + DAY });
  assert.deepEqual([first.status, first.invoiceNumber, first.completedOn], ["issued", "TKP/25-26/00001", "2026-03-31"]);
  assert.deepEqual([second.status, second.invoiceNumber, second.completedOn], ["issued", "TKP/26-27/00001", "2026-04-01"]);
  assert.deepEqual(sqlite.prepare("SELECT financial_year,prefix,next_number FROM finance_document_series_v2 ORDER BY financial_year").all().map((r) => [r.financial_year, r.prefix, r.next_number]), [["2025-26", "TKP/25-26/", 2], ["2026-27", "TKP/26-27/", 2]]);
  // An FY row Finance saved by hand still wins over the template; an issued number is never renumbered.
  await statutory.saveStatutorySeries(db, { entityId: ENTITY, gstin: GSTIN, documentType: "invoice", financialYear: "2027-28", prefix: "TK/27-28/", padding: 5, policyId: POLICY }, FINANCE);
  assert.equal(sqlite.prepare("SELECT invoice_number FROM finance_invoices WHERE source_id='BK-MAR'").get().invoice_number, "TKP/25-26/00001");
});

test("refusals are configuration_required with a plain message, and never block or fail the completion", async () => {
  // No seller in the active policy: nothing is invented.
  const noSeller = await invoiceWorld({ seller: null });
  await activeTerm(noSeller.db, { service: "grooming", model: "commission_groomer" });
  booking(noSeller.sqlite, "BK-1");
  assert.equal((await complete(noSeller.db, "BK-1")).gstLiability, 45.76, "the completion itself succeeds");
  assert.equal(invoiceRows(noSeller.sqlite).length, 0);
  const refused = await invoices.issueBookingInvoice(noSeller.db, { bookingId: "BK-1", actorId: FINANCE });
  assert.deepEqual([refused.status, refused.key], ["refused", "active_policy_seller"]);
  assert.match(refused.message, /No active tax policy names the seller/);

  // The seller's GSTIN has no active registration.
  const noRegistration = await invoiceWorld({ registration: false });
  await activeTerm(noRegistration.db, { service: "grooming", model: "commission_groomer" });
  booking(noRegistration.sqlite, "BK-2");
  await complete(noRegistration.db, "BK-2");
  const unregistered = await invoices.issueBookingInvoice(noRegistration.db, { bookingId: "BK-2", actorId: FINANCE });
  assert.deepEqual([unregistered.status, unregistered.key], ["refused", "active_tax_registration"]);

  // A service Finance classified with a SAC that cannot be printed is refused, and Finance's row is never overwritten.
  const badSac = await invoiceWorld();
  await activeTerm(badSac.db, { service: "grooming", model: "commission_groomer" });
  badSac.sqlite.prepare("INSERT INTO provider_capacity_profiles VALUES ('PRV-FT','Ravi','full_time')").run();
  badSac.sqlite.prepare("INSERT INTO tax_classifications (id,policy_id,service_code,classification_code,tax_component_json,place_of_supply_rule,input_tax_rule,created_at) VALUES ('SEEDTC-grooming',?,'grooming','SAC-9985-0',?,'buyer_state','standard',1)").run(POLICY, JSON.stringify([{ code: "CGST", rate: 9 }, { code: "SGST", rate: 9 }]));
  booking(badSac.sqlite, "BK-3", { provider: "PRV-FT" });
  await complete(badSac.db, "BK-3");
  const noSac = await invoices.issueBookingInvoice(badSac.db, { bookingId: "BK-3", actorId: FINANCE });
  assert.deepEqual([noSac.status, noSac.key], ["refused", "tax_classification_sac:grooming"]);
  assert.match(noSac.message, /Grooming has no valid SAC/);
  assert.equal(badSac.sqlite.prepare("SELECT classification_code FROM tax_classifications WHERE id='SEEDTC-grooming'").get().classification_code, "SAC-9985-0", "what Finance set is never overwritten");

  // A service with no default and no classification is refused too.
  const other = await invoiceWorld();
  const noClass = await attempt(() => invoices.updateServiceSac(other.db, { serviceCode: "grooming", sac: "SAC-9985-0", reason: "Try an unprintable SAC" }, FINANCE));
  assert.equal(noClass.status, 400, "an unprintable SAC is refused when it is SAVED");

  // No invoice series configured at all.
  const noSeries = await invoiceWorld({ series: null });
  await activeTerm(noSeries.db, { service: "grooming", model: "commission_groomer" });
  booking(noSeries.sqlite, "BK-4");
  await complete(noSeries.db, "BK-4");
  const unnumbered = await invoices.issueBookingInvoice(noSeries.db, { bookingId: "BK-4", actorId: FINANCE });
  assert.deepEqual([unnumbered.status, unnumbered.key], ["refused", "invoice_series"]);
});

test("defaults are seeded from the one SAC table when missing and audited, but a classification Finance set is used as it is", async () => {
  const { sqlite, db } = await invoiceWorld();
  await activeTerm(db, { service: "grooming", model: "commission_groomer" });
  sqlite.prepare("INSERT INTO provider_capacity_profiles VALUES ('PRV-FT','Ravi','full_time')").run();
  sqlite.prepare("INSERT INTO tax_classifications (id,policy_id,service_code,classification_code,tax_component_json,place_of_supply_rule,input_tax_rule,created_at) VALUES ('FIN-grooming',?,'grooming','999799',?,'default_recipient_or_service','standard',1)").run(POLICY, JSON.stringify([{ code: "CGST", rate: 9 }, { code: "SGST", rate: 9 }]));
  booking(sqlite, "BK-OWN", { provider: "PRV-FT" });
  booking(sqlite, "BK-COMM");
  await complete(db, "BK-OWN");
  await complete(db, "BK-COMM");
  const [own, comm] = invoiceRows(sqlite);
  assert.equal(linesOf(sqlite, own.id)[0].snap.classificationCode, "999799", "Finance's SAC wins over the default");
  assert.equal(linesOf(sqlite, comm.id)[1].snap.classificationCode, "998599", "PawSpace's fee is classified from the default table");
  assert.deepEqual(sqlite.prepare("SELECT service_code,classification_code,place_of_supply_rule FROM tax_classifications ORDER BY service_code").all().map((r) => [r.service_code, r.classification_code, r.place_of_supply_rule]), [["grooming", "999799", "default_recipient_or_service"], ["platform_commission", "998599", "default_recipient_or_service"]]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM gst_accounting_audit_events WHERE entity_type='tax_classification' AND action='seeded_default'").get().n, 1);

  // Finance changes a SAC on the GST screen: audited, the next invoice uses it, an issued invoice keeps what it printed.
  const changed = await invoices.updateServiceSac(db, { serviceCode: "grooming", sac: "998612", reason: "Explanatory Notes: pet grooming" }, FINANCE);
  assert.deepEqual([changed.sac, changed.unchanged], ["998612", false]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM gst_accounting_audit_events WHERE action='sac_changed'").get().n, 1);
  assert.equal(linesOf(sqlite, own.id)[0].snap.classificationCode, "999799");
});

for(const service of ['grooming','dog_training','boarding','pet_sitting','dog_walking','pet_taxi'])test(`basis guard: ${service} refuses a new own-supply invoice whose tax exceeds the billed amount`,async()=>{
 const {sqlite,db}=await invoiceWorld({inclusive:false});
 await activeTerm(db,{service,model:'direct_employee',share:0});
 sqlite.prepare("INSERT INTO provider_capacity_profiles VALUES ('PRV-G','Isolated basis fixture','full_time')").run();
 booking(sqlite,'BASIS-'+service,{service,amount:1146.65});
 const fact=await complete(db,'BASIS-'+service);
 assert.equal(fact.gstLiability,206.40,'existing configured percent-of-base GST is preserved');
 assert.equal(fact.platformRevenueNetOfGst,940.25);
 const result=await invoices.issueBookingInvoice(db,{bookingId:'BASIS-'+service,actorId:FINANCE});
 assert.equal(result.status,'refused');assert.equal(result.key,'invoice_tax_total_mismatch:'+service);
 assert.equal(invoiceRows(sqlite).length,0,'no inconsistent invoice issued');
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM finance_invoice_serial_claims').get().n,0,'refusal consumes no invoice number');
});
test('basis guard: commission invoice refuses tax greater than its billed platform-fee line',async()=>{
 const {sqlite,db}=await invoiceWorld({inclusive:false});await activeTerm(db,{service:'grooming',model:'commission_groomer'});
 sqlite.prepare("INSERT INTO provider_capacity_profiles VALUES ('PRV-G','Isolated commission fixture','commission')").run();
 booking(sqlite,'BASIS-COMM');await complete(db,'BASIS-COMM');
 const result=await invoices.issueBookingInvoice(db,{bookingId:'BASIS-COMM',actorId:FINANCE});
 assert.equal(result.status,'refused');assert.equal(result.key,'invoice_tax_total_mismatch:platform_commission');
 assert.equal(invoiceRows(sqlite).length,0);
});
for(const service of ['grooming','dog_training','boarding','pet_sitting','dog_walking','pet_taxi'])test(`basis guard: approved inclusive ${service} reconciles invoice, completion and replay`,async()=>{
 const {sqlite,db}=await invoiceWorld();
 const {saveGstSetting}=await import('../lib/gst-setting.ts');
 await saveGstSetting(db,{cityId:'blr',ratePercent:18,method:'extract_inclusive',effectiveFrom:'2024-01-01',reason:'Isolated explicit inclusive basis fixture',actorId:FINANCE});
 await activeTerm(db,{service,model:'direct_employee',share:0});
 sqlite.prepare("INSERT INTO provider_capacity_profiles VALUES ('PRV-G','Isolated inclusive fixture','full_time')").run();
 booking(sqlite,'BASIS-INCLUSIVE',{service,amount:1146.65});
 const fact=await complete(db,'BASIS-INCLUSIVE');assert.equal(fact.gstLiability,174.91);assert.equal(fact.platformRevenueNetOfGst,971.74);
 assert.equal(sqlite.prepare("SELECT total_amount FROM canonical_bookings WHERE id='BASIS-INCLUSIVE'").get().total_amount,1146.65,'approved customer total remains unchanged');
 const [first]=invoiceRows(sqlite);assert.deepEqual([first.subtotal,first.tax_total,first.total],[971.74,174.91,1146.65]);
 assert.equal(Number((first.subtotal+first.tax_total).toFixed(2)),first.total);
 await complete(db,'BASIS-INCLUSIVE');const replay=await invoices.issueBookingInvoice(db,{bookingId:'BASIS-INCLUSIVE',actorId:FINANCE});
 assert.equal(replay.status,'existing');assert.equal(replay.invoiceId,first.id);assert.equal(invoiceRows(sqlite).length,1);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM finance_invoice_serial_claims').get().n,1);
});

test('basis guard: replay preserves legacy issued invoice bytes without allocating a new number',async()=>{
 const {sqlite,db}=await invoiceWorld();
 await statutory.ensureStatutoryInvoiceTables(db);
 sqlite.prepare("INSERT INTO finance_invoices (id,invoice_number,entity_id,customer_id,source_type,source_id,source_event_key,policy_id,registration_id,issue_date,currency,subtotal,tax_total,total,status,tax_snapshot_json,created_by,created_at) VALUES ('LEGACY-BASIS','TKP/26-27/09999',?,'CUS-LEGACY','booking','LEGACY-BK','booking-invoice:LEGACY-BK',?,?,'2026-10-01','INR',1146.65,206.4,1146.65,'issued',?, ?,1)").run(ENTITY,POLICY,REG,JSON.stringify({legacy:true,taxable:1146.65,tax:206.4,total:1146.65}),FINANCE);
 const before=sqlite.prepare("SELECT * FROM finance_invoices WHERE id='LEGACY-BASIS'").get();
 const replay=await statutory.issueInvoiceStatutory(db,{entityId:ENTITY,issueDate:TODAY,sourceEventKey:'booking-invoice:LEGACY-BK',lines:[{serviceCode:'grooming',taxableAmount:1146.65,lineAmount:1146.65}]},FINANCE);
 assert.deepEqual(replay,before);assert.deepEqual(sqlite.prepare("SELECT * FROM finance_invoices WHERE id='LEGACY-BASIS'").get(),before);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM finance_invoice_serial_claims').get().n,0);
});

test('basis guard: non-GST and exempt new fixtures retain their bill-of-supply path',async()=>{
 const {sqlite,db}=await invoiceWorld();await activeTerm(db,{service:'funeral_memorial'});
 for(const [id,treatment]of [['BASIS-NONGST','non_gst'],['BASIS-EXEMPT','exempt']]){
  if(treatment==='exempt')await funeral.saveFuneralGstTreatment(db,{treatment:'exempt',effectiveFrom:'2024-01-01',reason:'Isolated exemption preservation fixture',actorId:FINANCE});
  booking(sqlite,id,{service:'funeral_memorial',provider:'PRV-VENDOR'});const fact=await complete(db,id);assert.equal(fact.gstLiability,0);
  const invoice=invoiceRows(sqlite).find(row=>row.source_id===id);assert.ok(invoice);assert.equal(invoice.document_kind,'bill_of_supply');assert.equal(invoice.total,1000);assert.equal(invoice.tax_total,0);
 }
});

 test('basis guard: approved inclusive commission keeps provider share and customer total unchanged',async()=>{
 const {sqlite,db}=await invoiceWorld();const {saveGstSetting}=await import('../lib/gst-setting.ts');
 await saveGstSetting(db,{cityId:'blr',ratePercent:18,method:'extract_inclusive',effectiveFrom:'2024-01-01',reason:'Owner approved inclusive allocation isolated fixture',actorId:FINANCE});
 await activeTerm(db,{service:'grooming',model:'commission_groomer'});
 sqlite.prepare("INSERT INTO provider_capacity_profiles VALUES ('PRV-G','Isolated commission fixture','commission')").run();
 booking(sqlite,'INCLUSIVE-COMMISSION');const fact=await complete(db,'INCLUSIVE-COMMISSION');
 assert.equal(fact.gstLiability,45.76);assert.equal(fact.platformRevenueNetOfGst,254.24);
 const [invoice]=invoiceRows(sqlite);assert.equal(invoice.total,1000);assert.equal(invoice.subtotal,254.24);assert.equal(invoice.tax_total,45.76);
 const [provider,fee]=linesOf(sqlite,invoice.id);assert.equal(provider.snap.lineAmount,700);assert.equal(fee.snap.lineAmount,300);
 assert.equal(Number((invoice.subtotal+invoice.tax_total+provider.snap.lineAmount).toFixed(2)),invoice.total);
 await complete(db,'INCLUSIVE-COMMISSION');assert.equal(invoiceRows(sqlite).length,1);
 });
