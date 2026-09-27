/**
 * A lead added by staff is the customer the person signs in as, and a Boarding or Pet Sitting lead can be moved to a
 * booking (round-2 staging, 50-leads-crm, P1).
 *
 * "＋ Add lead" in /crm wrote a CRM contact only (CU-12345) and no canonical customer. When the person signed in with the
 * same number, sign-in created another customer (CUS-OTP-...), their booking landed there, and
 * attributeBookingToOpenLead - which links a booking to an open lead of the SAME customer id - never found the lead. A
 * lead for someone PawSpace already knew became a second contact beside their real account. And "Book this customer →"
 * opened a Grooming-only page, so a Boarding or Pet Sitting lead had no way to a booking at all.
 *
 * Executed against the real /api/crm route, the real OTP sign-in and the real lead attribution, on node:sqlite.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, seedActors, asActor } from "./helpers/execution-harness.mjs";

installWorkersHooks("__LEAD_CUSTOMER_IDENTITY_DB__", "__LEAD_CUSTOMER_IDENTITY_ENV__");
const crm = await import("../app/api/crm/route.ts");
const otp = await import("../lib/customer-otp.ts");
const attribution = await import("../lib/lead-conversion-attribution.ts");
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const crmDdl = read("app/api/crm/route.ts").match(/CREATE TABLE IF NOT EXISTS crm_contacts [^"]+/)[0];

const FOUNDER = "lead.identity.founder@pawspace.test";
const ENV = { PAWSPACE_WORKSPACE_IDENTITY_TRUST: "openai-dispatch", PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT: "lead-identity-assertion-secret-0123456789abcdef" };

async function staffWorld() {
  const w = world("__LEAD_CUSTOMER_IDENTITY_DB__", "__LEAD_CUSTOMER_IDENTITY_ENV__", ENV);
  await seedActors(w.sqlite, w.db, [{ id: "LEAD-IDENTITY-FOUNDER", email: FOUNDER, role: "founder" }]);
  const { ensureCustomerAccountTables } = await import("../lib/customer-account.ts");
  await ensureCustomerAccountTables(w.db);
  return w;
}
async function addLead(body) {
  const response = await crm.POST(asActor(FOUNDER, "/api/crm", { method: "POST", body: JSON.stringify({ petNames: "Bruno", source: "Manual CRM", stage: "New lead", whatsappConsent: false, ...body }) }));
  return { status: response.status, body: await response.json() };
}
async function signIn(db, phone) {
  const challenge = await otp.requestCustomerOtp(db, { phone });
  const verified = await otp.verifyCustomerOtp(db, { challengeId: challenge.challengeId, code: challenge.sandboxCode, name: "Lead Person" });
  return { existingCustomer: challenge.existingCustomer, customerId: verified.customerId };
}
function customer(sqlite, id, phone, createdAt = Date.now()) {
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES (?,'blr',?,?,'public_contact','{}',?,?)").run(id, `Customer ${id}`, phone, createdAt, createdAt);
}
/** The lead's own booking as the customer app creates it, then its payment captured. */
async function bookAndPay(sqlite, db, customerId, serviceCode, bookingId) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,service_code TEXT NOT NULL,total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR')");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,customer_id TEXT NOT NULL,amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',status TEXT NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,total_amount) VALUES (?,?,?,?)").run(bookingId, customerId, serviceCode, 1998);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,status,updated_at) VALUES (?,?,?,?,'created',?)").run(`PAY-${bookingId}`, bookingId, customerId, 1998, Date.now());
  const linked = await attribution.attributeBookingToOpenLead(db, { customerId, bookingId });
  sqlite.prepare("UPDATE booking_payments SET status='captured',updated_at=? WHERE booking_id=?").run(Date.now() + 1, bookingId);
  const converted = await attribution.convertLeadOnPaymentCaptured(db, { customerId, bookingId });
  return { linked, converted };
}

test("a staff lead is a canonical customer from the start: the person's sign-in and paid Boarding booking reach the lead", async () => {
  const { sqlite, db } = await staffWorld();
  const created = await addLead({ name: "Asha Rao", primaryPhone: "+91 90000 00812", service: "Boarding" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.existingCustomer, false);
  assert.deepEqual({ ...sqlite.prepare("SELECT id,primary_phone,source FROM canonical_customers").get() }, { id: created.body.id, primary_phone: "9000000812", source: "staff_crm" }, "the canonical customer keeps the CRM id and the one stored form of the number");

  const person = await signIn(db, "9000000812");
  assert.deepEqual(person, { existingCustomer: true, customerId: created.body.id }, "sign-in reaches the lead's customer, not a new CUS-OTP one");
  const { linked, converted } = await bookAndPay(sqlite, db, person.customerId, "boarding", "PS-STAFF-LEAD-BOARDING");
  assert.deepEqual({ ...linked }, { leadId: created.body.leadId, converted: false, attribution: "lead" });
  assert.deepEqual(converted, { leadId: created.body.leadId });
  assert.equal(sqlite.prepare("SELECT converted_booking_id FROM lead_work_items WHERE id=?").get(created.body.leadId).converted_booking_id, "PS-STAFF-LEAD-BOARDING");
});

test("a staff lead for someone PawSpace knows (their number stored in another form) joins that customer, not a second contact", async () => {
  const { sqlite, db } = await staffWorld();
  const now = Date.now();
  customer(sqlite, "CU-CHAT-ERA", "+919000000813", now - 86_400_000);
  sqlite.exec(crmDdl);
  sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,area,pet_names,pet_summary,stage,owner,source,lifetime_value,next_action,opportunity,created_at,updated_at) VALUES ('CU-CHAT-ERA','Asha Chat','+919000000813','Indiranagar','Dog x 1','Boarding enquiry','Active customer','AI Orchestrator','Website contact form',0,'AI qualification in progress','Boarding',?,?)").run(now, now);
  const created = await addLead({ name: "Asha", primaryPhone: "9000000813", petNames: "Coco", service: "Pet Sitting" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.id, "CU-CHAT-ERA"); assert.equal(created.body.existingCustomer, true);
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) n FROM canonical_customers").get().n), 1, "no second customer");
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) n FROM crm_contacts").get().n), 1, "no second contact");
  assert.deepEqual({ ...sqlite.prepare("SELECT name,primary_phone,area,stage,pet_names,opportunity FROM crm_contacts").get() },
    { name: "Asha Chat", primary_phone: "+919000000813", area: "Indiranagar", stage: "Active customer", pet_names: "Coco", opportunity: "Pet Sitting" }, "the contact keeps who they are; the new lead brings its pet and service");
  assert.deepEqual(sqlite.prepare("SELECT customer_id,service FROM lead_work_items").all().map((row) => ({ ...row })), [{ customer_id: "CU-CHAT-ERA", service: "Pet Sitting" }]);
  assert.equal((await signIn(db, "9000000813")).customerId, "CU-CHAT-ERA");
  const { converted } = await bookAndPay(sqlite, db, "CU-CHAT-ERA", "sitting", "PS-STAFF-LEAD-SITTING");
  assert.deepEqual(converted, { leadId: created.body.leadId }, "their paid Pet Sitting booking converts the staff lead");
});

test("a staff lead for a number already on two customers is not guessed: it stays a CRM contact and is flagged for review", async () => {
  const { sqlite } = await staffWorld();
  customer(sqlite, "CU-SPLIT-A", "+919000000814");
  customer(sqlite, "CUS-OTP-SPLIT-B", "9000000814");
  const created = await addLead({ name: "Split Person", primaryPhone: "9000000814", service: "Boarding" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.identityReview, true);
  assert.ok(!["CU-SPLIT-A", "CUS-OTP-SPLIT-B"].includes(created.body.id));
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) n FROM canonical_customers").get().n), 2, "no third customer is minted");
});

test("a new staff lead never adopts another person's CRM id: a taken 5-digit id gets a fresh customer id instead", async () => {
  const { sqlite, db } = await staffWorld();
  const now = Date.now();
  sqlite.exec(crmDdl);
  // Another person's CRM-only contact from before this fix, holding the id the route happened to propose.
  sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,area,stage,owner,source,created_at,updated_at) VALUES ('CU-25555','Someone Else','9000000899','Bangalore','New lead','Unassigned','Manual CRM',?,?)").run(now, now);
  const { resolveStaffLeadCustomer } = await import("../lib/lead-customer-identity.ts");
  const resolved = await resolveStaffLeadCustomer(db, { proposedCustomerId: "CU-25555", name: "New Person", phone: "9000000815", cityId: "blr", now });
  assert.notEqual(resolved.customerId, "CU-25555");
  assert.equal(resolved.newCanonicalCustomer, true);
  assert.deepEqual({ ...sqlite.prepare("SELECT name,primary_phone FROM canonical_customers WHERE id=?").get(resolved.customerId) }, { name: "New Person", primary_phone: "9000000815" });
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM canonical_customers WHERE id='CU-25555'").get().n, 0, "the other person's id gains no canonical record");
});

async function renderLinks(props) {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const { default: StayBookingLinks } = await import("../app/assisted-booking/stay-booking-links.tsx");
  return renderToStaticMarkup(React.createElement(StayBookingLinks, props));
}

test("Book this customer → offers Boarding and Pet Sitting booking links that tell the lead to sign in with their number", async () => {
  const links = await import("../lib/stay-booking-link.ts");
  assert.match(links.stayBookingLinkMessage("boarding", "  Asha   Rao ", "https://pawspace.in/"), /^Hi Asha, here is your PawSpace Boarding booking link: https:\/\/pawspace\.in\/v2\/boarding\?source=crm\nSign in with the mobile number you gave us, /);
  assert.match(links.stayBookingLinkMessage("pet_sitting", "", "https://pawspace.in"), /^Hi there, here is your PawSpace Pet Sitting booking link: https:\/\/pawspace\.in\/v2\/sitting\?source=crm\n/);
  assert.equal(links.stayBookingWhatsAppUrl("+91 ••••••0812", "x"), null, "the masked number staff see gets no WhatsApp link");
  assert.equal(links.stayBookingWhatsAppUrl("9000000812", "Hi & welcome"), "https://wa.me/919000000812?text=Hi%20%26%20welcome");

  const masked = await renderLinks({ name: "Asha Rao", phone: "+91 ••••••0812" });
  assert.match(masked, /Copy Boarding booking link/); assert.match(masked, /Copy Pet Sitting booking link/);
  assert.doesNotMatch(masked, /WhatsApp/, "no WhatsApp for a masked number: staff copy the link");
  assert.match(await renderLinks({ name: "Asha Rao", phone: "9000000812" }), /Send Boarding link on WhatsApp/);
  // The page every "Book this customer →" opens shows the links for the selected customer; nothing is sent by PawSpace.
  assert.match(read("app/assisted-booking/page.tsx"), /\{customer&&<StayBookingLinks name=\{customer\.name\} phone=\{customer\.primaryPhone\}\/>\}/);
  assert.doesNotMatch(read("app/assisted-booking/stay-booking-links.tsx"), /fetch\(|\/api\//);
});
