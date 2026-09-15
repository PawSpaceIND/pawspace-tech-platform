/*
 * R3-C / F5 — the relocation enquiry directory served raw PII. [PTJA-R3-RELQ-PII]
 *
 * MEASURED against the running server, same actor, same second, superuser preview OFF:
 *   GET /api/relocation-enquiry  -> {"customerName":"R3C InApp Reloc","phonePrimary":"9811100166",
 *                                    "email":"r3c.inapp@pawspace.test","pickupLocation":"Koramangala, Bengaluru"}
 *   GET /api/crm                 -> {"name":"E•• U• C•","primary_phone":"+91 ••••••0111","revealed":false}
 * as r3c.associate@pawspace.test, role `associate`, no MFA. The route file contained no maskName, no
 * maskPhone and no `revealed` at all.
 *
 * These tests run the REAL route handlers over real SQLite with real authorization, and they grep the
 * WHOLE serialised payload rather than one field, because the leak was four fields wide and a
 * field-by-field assertion is exactly how a fifth one survives.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { importLibModule } from "./helpers/ts-module-loader.mjs";
import { installWorkersHooks, enterWorkersDbScope } from "./helpers/module-hooks.mjs";

installWorkersHooks("__RELQ_PII_DB__", "__RELQ_PII_ENV__");

const { maskName } = await importLibModule("platform-security");

// Single distinctive words, so that a partial leak still fails: maskName keeps each word's first letter.
const NAME = "Relocleak Pettranspx";
const PHONE = "9812345671";
const EMAIL = "relocleak.subject@example.in";
// Multi-segment on purpose: the doorstep token is what must never survive a masked read, and the
// trailing city is the "area" the approved policy explicitly lets staff keep.
const PICKUP = "Flat 9 Leakstreetx, Koramangala, Bengaluru";
const DROP = "Plot 3 Leakroadx, Baner, Pune";

/** Non-preview host: on localhost every actor is the preview superuser and nothing here is measurable. */
const URL_BASE = "https://uat.pawspace.in/api/relocation-enquiry";

async function staffWorld(email, role) {
  const { sqlite, db } = freshCountingD1();
  enterWorkersDbScope(db);
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const now = Date.now();
  await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
    .bind(`USR-${role}`, email, `Staff ${role}`, role, now, now).run();
  return { sqlite, db, now, headers: { "oai-authenticated-user-email": email } };
}

/** Written through the REAL public POST handler, so the row under test is the row the product creates. */
async function submitEnquiry(route) {
  const response = await route.POST(new Request(URL_BASE, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      customerName: NAME, phonePrimary: PHONE, phoneSecondary: "9812345672", email: EMAIL,
      petType: "dog", relocationKind: "domestic", pickupDate: "2026-10-05", pickupApproxTime: "09:30",
      pickupLocation: PICKUP, dropLocation: DROP, expectedTravelDate: "2026-10-08",
    }),
  }));
  assert.equal(response.status, 200, `the public form must still submit: ${(await response.clone().text()).slice(0, 300)}`);
  return (await response.json()).data.id;
}

function assertNoRawPii(payload, label) {
  for (const secret of [NAME, "Relocleak", "Pettranspx", PHONE, EMAIL, PICKUP, DROP, "Leakstreetx", "Leakroadx"]) {
    assert.ok(!payload.includes(secret), `${label}: "${secret}" must appear nowhere in the payload: ${payload.slice(0, 500)}`);
  }
}

test("RELQ-PII-01: an associate reads the directory with no raw name, phone, email or address anywhere in the payload", async () => {
  const world = await staffWorld("associate@pawspace.test", "associate");
  const route = await import("../app/api/relocation-enquiry/route.ts");
  const id = await submitEnquiry(route);

  const response = await route.GET(new Request(URL_BASE, { headers: world.headers }));
  assert.equal(response.status, 200, "an associate may still open the directory");
  const payload = await response.text();
  const row = JSON.parse(payload).data.find((entry) => entry.id === id);

  // NON-VACUITY FIRST: the row really is in the list, so the assertions below are about masking and
  // not about an empty result.
  assert.ok(row, "the submitted enquiry must be listed");
  assert.equal(row.petType, "dog", "the non-PII columns still arrive - the row is served, not dropped");
  assert.equal(row.customerName, maskName(NAME), "the name is masked exactly as every sibling CRM list masks it");
  assert.equal(row.revealed, false, "a list read is not a reveal");
  assert.equal(row.addressPrecision, "area", "the doorstep is closed; the area is what survives");
  assert.match(row.pickupLocation, /•/, "masked, not deleted - staff must still recognise the record");
  assert.match(row.dropLocation, /•/);
  assertNoRawPii(payload, "associate list read");
});

test("RELQ-PII-02: a founder's list read is masked too - seniority is not a reveal", async () => {
  const world = await staffWorld("founder@pawspace.test", "founder");
  const route = await import("../app/api/relocation-enquiry/route.ts");
  const id = await submitEnquiry(route);

  const response = await route.GET(new Request(URL_BASE, { headers: world.headers }));
  const payload = await response.text();
  const row = JSON.parse(payload).data.find((entry) => entry.id === id);
  assert.ok(row, "the founder sees the row");
  assert.equal(row.revealed, false, "nothing was revealed, so nothing claims to have been");
  assert.equal(JSON.parse(payload).revealAvailable, true, "but the screen is told a reveal would succeed");
  assertNoRawPii(payload, "founder list read");
});

test("RELQ-PII-03: an associate asking for a reveal is refused and still gets nothing raw", async () => {
  const world = await staffWorld("associate2@pawspace.test", "associate");
  const route = await import("../app/api/relocation-enquiry/route.ts");
  const id = await submitEnquiry(route);

  const response = await route.GET(new Request(`${URL_BASE}?reveal=${id}&reason=Customer%20asked%20me%20to%20call%20back`, { headers: world.headers }));
  const payload = await response.text();
  assert.equal(response.status, 403, `an associate holds no reveal grant: ${payload.slice(0, 300)}`);
  assert.equal(JSON.parse(payload).code, "reveal_not_permitted");
  assertNoRawPii(payload, "refused reveal");
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) c FROM customer_data_reveals WHERE subject_id=?").get(id).c, 0,
    "a refusal reveals nothing, so it records no reveal");
});

test("RELQ-PII-04: a reveal without a reason is refused before anything is read", async () => {
  const world = await staffWorld("founder2@pawspace.test", "founder");
  const route = await import("../app/api/relocation-enquiry/route.ts");
  const id = await submitEnquiry(route);
  const response = await route.GET(new Request(`${URL_BASE}?reveal=${id}`, { headers: world.headers }));
  const payload = await response.text();
  assert.equal(response.status, 400, payload.slice(0, 300));
  assert.equal(JSON.parse(payload).code, "reveal_reason_required");
  assertNoRawPii(payload, "reason-less reveal");
});

test("RELQ-PII-05: a privileged actor who asks, with a reason, still gets the real name, phone, email and BOTH addresses", async () => {
  // NON-VACUITY FOR THE FIX ITSELF. Masking everything unconditionally would satisfy every assertion
  // above and leave the relocation desk unable to phone anyone or plan a route.
  const world = await staffWorld("founder3@pawspace.test", "founder");
  const route = await import("../app/api/relocation-enquiry/route.ts");
  const id = await submitEnquiry(route);

  const response = await route.GET(new Request(`${URL_BASE}?reveal=${id}&reason=Planning%20the%20pickup%20route%20with%20the%20driver`, { headers: world.headers }));
  const payload = await response.text();
  assert.equal(response.status, 200, payload.slice(0, 300));
  const rows = JSON.parse(payload).data;
  const row = rows.find((entry) => entry.id === id);
  assert.equal(row.revealed, true, "the reveal actually happened");
  assert.equal(row.customerName, NAME, "the real name");
  assert.equal(row.phonePrimary, PHONE, "the real number");
  assert.equal(row.email, EMAIL, "the real email");
  assert.equal(row.pickupLocation, PICKUP, "the real pickup address");
  assert.equal(row.dropLocation, DROP, "the real drop address");
  assert.equal(row.addressPrecision, "full");
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) c FROM customer_data_reveals WHERE subject_id=?").get(id).c, 1,
    "and the reveal is recorded with the actor, the record and the reason");

  // ONE record, not the list: a second enquiry in the same response stays masked.
  const other = rows.find((entry) => entry.id !== id);
  if (other) assert.equal(other.revealed, false, "a reveal names one record and opens one record");
});
