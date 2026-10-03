/*
 * The printable customer tax invoice (app/api/booking-invoice): the booking's own customer, Finance and the Booking Command
 * Center can open it; nobody else can, and another customer cannot even learn that it exists. Driven through the REAL route
 * and the REAL worker gateway on a real host (a preview host would grant a superuser and prove nothing).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, seedActors, ORIGIN } from "./helpers/execution-harness.mjs";

installWorkersHooks("__INVOICE_ROUTE_DB__", "__INVOICE_ROUTE_ENV__");
const terms = await import("../lib/provider-commercial-terms.ts");
const completion = await import("../lib/service-completion-finance.ts");
const gstAccounting = await import("../lib/gst-accounting.ts");
const route = await import("../app/api/booking-invoice/route.ts");
const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
const { authorizeApiRequest } = await import("../lib/api-gateway.ts");

const ENTITY = "SEEDFE-TKPET", GSTIN = "29AAICT7352F1Z0", NOW = Date.now();
const SELLER = { legalName: "TK PETCARE SOLUTIONS PRIVATE LIMITED", gstin: GSTIN, stateCode: "29", state: "Karnataka", address: "Jayanagar 9th Block, Bengaluru, Karnataka 560041" };
const FINANCE = "finance.staff@pawspace.in", MANAGER = "ops.manager@pawspace.in", SHOPPER = "shopper@pawspace.in";

async function customerCookie(db, customerId) {
  const identitySource = "customer_otp", subjectType = "customer", principalType = "identity_subject", principalKey = `customer:${customerId}`;
  const binding = await upsertIdentityBinding(db, { identitySource, principalType, principalKey, subjectType, subjectId: customerId, verificationState: "verified", actorId: "test", reason: "customer invoice access regression" });
  const issued = await issuePlatformSession(db, { bindingId: String(binding.id), identitySource, principalType, principalKey, subjectType, subjectId: customerId });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}
async function invoicedWorld() {
  const { sqlite, db } = world("__INVOICE_ROUTE_DB__", "__INVOICE_ROUTE_ENV__", { NODE_ENV: "production", PAWSPACE_LOCAL_PREVIEW: "off" });
  sqlite.exec(`
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,pet_ids_json TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,total_amount REAL,currency TEXT,pricing_json TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER);
  `);
  await gstAccounting.ensureGstAccountingTables(db);
  // Approved inclusive economics apply only to this disposable fixture.
  const { saveGstSetting } = await import("../lib/gst-setting.ts");
  await saveGstSetting(db, { cityId: "*", ratePercent: 18, method: "extract_inclusive", effectiveFrom: "2024-01-01", reason: "Owner-approved inclusive finance fixture", actorId: "finance.fixture@pawspace.test" });
  sqlite.prepare("INSERT INTO finance_entities (id,legal_name,country_code,status,approved_by,approved_at,created_at,updated_at) VALUES (?,?,'IN','active','founder',1,1,1)").run(ENTITY, SELLER.legalName);
  sqlite.prepare("INSERT INTO tax_registrations (id,entity_id,jurisdiction,registration_type,registration_reference,status,effective_from,effective_to,approved_by,approved_at,created_at,updated_at) VALUES ('SEEDTR-TKPET-KA',?,'IN-KA','gstin',?,'active','2024-01-01',NULL,'founder',1,1,1)").run(ENTITY, GSTIN);
  sqlite.prepare("INSERT INTO tax_policy_versions (id,entity_id,version,status,effective_from,effective_to,policy_json,approval_reference,approved_by,approved_at,created_at,updated_at) VALUES ('SEEDTP-TKPET-1',?,1,'active','2024-01-01',NULL,?,'APR','founder',1,1,1)").run(ENTITY, JSON.stringify({ seller: SELLER }));
  sqlite.prepare("INSERT INTO finance_document_series (id,entity_id,document_type,prefix,next_number,padding,policy_id,status,updated_at) VALUES ('SERIES-TKP',?,'invoice','TKP/{FY}/',1,5,'SEEDTP-TKPET-1','active',1)").run(ENTITY);
  const draft = await terms.saveCommercialTerm(db, { serviceCode: "grooming", engagementModel: "commission_groomer", providerSharePct: 0.70, effectiveFrom: "2024-01-01", reason: "grooming owner model terms", actorId: "maker@pawspace.in" });
  await terms.activateCommercialTerm(db, { termId: draft.id, approvalReference: "APR-GROOM", actorId: "checker@pawspace.in" });
  for (const [id, customer] of [["BK-A", "CUS-A"], ["BK-B", "CUS-B"]]) {
    const start = new Date(NOW - 3600_000).toISOString();
    sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,pet_ids_json,city_id,zone_id,service_code,package_code,package_name,provider_id,scheduled_start,scheduled_end,status,total_amount,currency,pricing_json,created_at,updated_at) VALUES (?,?,'[]','blr','blr-east','grooming','pkg','Full groom','PRV-G',?,?,'completed',1000,'INR','{}',1,1)").run(id, customer, start, start);
    sqlite.prepare("INSERT INTO booking_payments VALUES (?,?,?,1000,1000,'INR','upi','prepaid','captured','razorpay',?,'{}',1,1)").run(`PAY-${id}`, id, customer, `idem-${id}`);
    await completion.resolveServiceCompletionFinance(db, { bookingId: id, actorId: "finance@pawspace.in", completedAt: NOW });
  }
  // A booking of customer A that has no invoice (not completed).
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,pet_ids_json,city_id,zone_id,service_code,package_code,package_name,provider_id,scheduled_start,scheduled_end,status,total_amount,currency,pricing_json,created_at,updated_at) VALUES ('BK-A-OPEN','CUS-A','[]','blr','blr-east','grooming','pkg','Full groom','PRV-G',?,?,'confirmed',1000,'INR','{}',1,1)").run(new Date(NOW).toISOString(), new Date(NOW).toISOString());
  await seedActors(sqlite, db, [{ id: "USR-FIN", email: FINANCE, role: "finance" }, { id: "USR-MGR", email: MANAGER, role: "manager" }, { id: "USR-SHOP", email: SHOPPER, role: "customer" }]);
  // The Booking Command Center's manager is scoped to Bengaluru operations, exactly as that screen requires.
  const { ensurePeopleTables } = await import("../lib/people-foundation.ts");
  await ensurePeopleTables(db);
  sqlite.prepare("INSERT INTO employees (id,user_email,employee_code,display_name,work_email,phone,employment_status,joined_at,created_at,updated_at) VALUES ('EMP-OPS',?,'EMP-OPS','Ops Manager',?,'9999999999','active',1,1,1)").run(MANAGER, MANAGER);
  sqlite.prepare("INSERT INTO employee_employment_versions (id,employee_id,version,effective_from,effective_until,employment_type,probation_status,title,team_code,manager_employee_id,cost_centre_code,location_code,reason,actor_id,created_at) VALUES ('EEV-OPS','EMP-OPS',1,1,NULL,'full_time','confirmed','Operations Manager','operations',NULL,'CC-OPERATIONS','BLR','Scoped operations manager','test',1)").run();
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,pet_ids_json,city_id,zone_id,service_code,package_code,package_name,provider_id,scheduled_start,scheduled_end,status,total_amount,currency,pricing_json,created_at,updated_at) VALUES ('BK-HYD','CUS-H','[]','hyd','hyd-west','grooming','pkg','Full groom','PRV-H',?,?,'confirmed',1000,'INR','{}',1,1)").run(new Date(NOW).toISOString(), new Date(NOW).toISOString());
  return { sqlite, db, cookieA: await customerCookie(db, "CUS-A"), cookieB: await customerCookie(db, "CUS-B") };
}
const get = (path, headers = {}) => route.GET(new Request(`${ORIGIN}${path}`, { headers }));
const asStaff = (email) => ({ "oai-authenticated-user-email": email });

test("the booking's own customer opens the printable invoice; the page is A4 HTML with its own content policy", async () => {
  const { sqlite, cookieA } = await invoicedWorld();
  const number = sqlite.prepare("SELECT invoice_number FROM finance_invoices WHERE source_id='BK-A'").get().invoice_number;
  const response = await get("/api/booking-invoice?bookingId=BK-A", { cookie: cookieA });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/html/);
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
  const html = await response.text();
  assert.ok(html.includes(number) && html.includes("@page{size:A4") && html.includes("Tax payable on reverse charge: No"));
  const json = await (await get("/api/booking-invoice?bookingId=BK-A&format=json", { cookie: cookieA })).json();
  assert.deepEqual(json.data, { invoiceNumber: number, issueDate: new Date(NOW + 330 * 60_000).toISOString().slice(0, 10), title: "Tax invoice", amountReceived: 1000 });
  const open = await (await get("/api/booking-invoice?bookingId=BK-A-OPEN&format=json", { cookie: cookieA })).json();
  assert.deepEqual(open, { data: null }, "the customer's own booking with no invoice yet: nothing to download");
});

test("another customer gets the same 404 as a booking that does not exist, so an invoice's existence never leaks", async () => {
  const { cookieA, cookieB } = await invoicedWorld();
  const foreign = await get("/api/booking-invoice?bookingId=BK-A", { cookie: cookieB });
  const missing = await get("/api/booking-invoice?bookingId=BK-NOPE", { cookie: cookieB });
  assert.equal(foreign.status, 404);
  assert.equal(missing.status, 404);
  assert.equal(await foreign.text(), await missing.text(), "identical replies");
  const foreignJson = await get("/api/booking-invoice?bookingId=BK-B&format=json", { cookie: cookieA });
  assert.equal(foreignJson.status, 404);
  assert.deepEqual(await foreignJson.json(), { error: "Invoice not found" });
});

test("staff open it with the permission their screen already uses, and the view is audited", async () => {
  const { sqlite } = await invoicedWorld();
  const finance = await get("/api/booking-invoice?bookingId=BK-A&view=finance", asStaff(FINANCE));
  assert.equal(finance.status, 200, "Finance (finance.view)");
  const operations = await get("/api/booking-invoice?bookingId=BK-B&view=operations", asStaff(MANAGER));
  assert.equal(operations.status, 200, "Booking Command Center (bookings.manage)");
  assert.equal((await get("/api/booking-invoice?bookingId=BK-HYD&view=operations", asStaff(MANAGER))).status, 403, "a Bengaluru manager cannot open a Hyderabad booking's invoice");
  assert.equal((await get("/api/booking-invoice?bookingId=BK-A&view=operations", asStaff(FINANCE))).status, 403, "Finance holds no bookings.manage");
  assert.equal((await get("/api/booking-invoice?bookingId=BK-A&view=finance", asStaff(MANAGER))).status, 403, "a manager holds no finance.view");
  assert.equal((await get("/api/booking-invoice?bookingId=BK-A", asStaff(FINANCE))).status, 401, "staff without a view are not a customer session");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM security_audit_events WHERE action='booking.invoice.view' AND outcome='allowed'").get().n, 2);
});

test("an anonymous visitor or a customer identity without a session is refused", async () => {
  await invoicedWorld();
  const anonymous = await get("/api/booking-invoice?bookingId=BK-A");
  assert.ok([401, 403].includes(anonymous.status), `anonymous got ${anonymous.status}`);
  assert.ok([401, 403].includes((await get("/api/booking-invoice?bookingId=BK-A&view=finance")).status));
  assert.ok([401, 403].includes((await get("/api/booking-invoice?bookingId=BK-A&view=finance", asStaff(SHOPPER))).status));
  assert.equal((await get("/api/booking-invoice?bookingId=BK-A", asStaff(SHOPPER))).status, 401, "a customer role with no customer session sees nothing");
});

test("the worker gateway lets each audience reach the route with its own permission and no one else", async () => {
  const { db, cookieA } = await invoicedWorld();
  const gateway = (path, headers = {}) => authorizeApiRequest(new Request(`${ORIGIN}${path}`, { headers }), { DB: db });
  const customer = await gateway("/api/booking-invoice?bookingId=BK-A", { cookie: cookieA });
  assert.ok(!(customer instanceof Response));
  assert.deepEqual([customer.permission, customer.actor.roleCode], ["scheduling.book", "customer"]);
  const customerAsFinance = await gateway("/api/booking-invoice?bookingId=BK-A&view=finance", { cookie: cookieA });
  assert.ok(customerAsFinance instanceof Response && customerAsFinance.status === 403, "a customer cannot take the Finance view");
  const finance = await gateway("/api/booking-invoice?bookingId=BK-A&view=finance", asStaff(FINANCE));
  assert.ok(!(finance instanceof Response));
  assert.equal(finance.permission, "finance.view");
  const manager = await gateway("/api/booking-invoice?bookingId=BK-A&view=operations", asStaff(MANAGER));
  assert.ok(!(manager instanceof Response));
  assert.equal(manager.permission, "bookings.manage");
  const anonymous = await gateway("/api/booking-invoice?bookingId=BK-A");
  assert.ok(anonymous instanceof Response && [401, 403].includes(anonymous.status));
});
