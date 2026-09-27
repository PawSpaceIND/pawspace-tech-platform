/**
 * PawSpace Total Journey Audit, Wave 2 Batch B — the customer identity takeover chain.
 *
 * Two halves, both required and both closed here: a self-asserted phone number could be written to a
 * customer record with no proof of possession, and OTP login treated that unverified number as an
 * equally valid identity for the person who really holds it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_IDT_DB__", "__PTJA_IDT_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  let depth = 0;
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      const outer = depth === 0;
      if (outer) sqlite.exec("BEGIN IMMEDIATE");
      depth += 1;
      try { const out = []; for (const item of items) out.push(await item.run()); if (outer) sqlite.exec("COMMIT"); return out; }
      catch (error) { if (outer) sqlite.exec("ROLLBACK"); throw error; }
      finally { depth -= 1; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

async function identityWorld() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_IDT_DB__ = db;
  globalThis.__PTJA_IDT_ENV__ = {};
  const account = await import("../lib/customer-account.ts");
  await account.ensureCustomerAccountTables(db);
  const now = Date.now();
  const customer = (id, name, primary, secondary = null) =>
    sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,'blr',?,?,?,?,'customer_app','{}',?,?)")
      .run(id, name, primary, secondary, `${id}@example.com`.toLowerCase(), now, now);
  return { sqlite, db, account, customer };
}

// =====================================================================================================
// PTJA-W2B-C04/C05 — the takeover chain
//
// (a) lib/customer-account.ts mutateCustomerAccount action=update_profile wrote an arbitrary
//     caller-supplied phone into secondary_phone (and primary_phone) with NO proof of possession and NO
//     uniqueness check against any other customer's numbers.
// (b) lib/customer-otp.ts resolved a login with
//       WHERE primary_phone=? OR secondary_phone=?   ... .first()
//     one OR-ed predicate, no ORDER BY, no tie-break - so a SECONDARY match and a PRIMARY match were
//     equally authoritative and .first() took whichever row the scan reached first.
//
// MEASURED, C05: an attacker's own session wrote {"secondaryPhone":"9845012345"} to their record and got
// 201. The person who genuinely holds that number then OTP-verified it and received
// {"customerId":"CUST-ATTACKER","customerName":"Mallory"} - a verified session on the attacker's
// customer id, with NO new customer row created. Everything the victim entered afterwards - address,
// pets, bookings, PawPoints - landed under the attacker's record and was readable from the attacker's
// own session.
//
// MEASURED, C04: the same defect with no attacker at all. Where one customer's primary_phone happens to
// sit in another customer's secondary_phone - a state CSV imports and shared household numbers produce
// routinely - the number's real owner was signed into the neighbour's account, and GET
// /api/customer-account then served that stranger's name, both phones, email, street address and pets.
//
// The corrections:
//   1. A self-asserted phone is CONTACT DATA, not a login identity. OTP resolves on primary_phone only.
//      A number nobody has verified cannot decide whose account you land in. Where no customer matches,
//      the existing signup path creates the caller their own record - which is the correct outcome for
//      the victim in both measured cases.
//   2. A profile write may not claim a phone number that already belongs to another customer.
//
// Behaviour change stated plainly: someone whose number is recorded ONLY as a secondary will now be
// signed in as a new customer rather than into the existing record. That is the safe direction, and it
// is the same direction the platform already takes for any number it has never seen.
// =====================================================================================================

test("W2B-C05: a planted secondary phone does not capture its real owner's login", async () => {
  const { db, customer } = await identityWorld();
  const otp = await import("../lib/customer-otp.ts");
  customer("CUST-ATTACKER", "Mallory", "9700000001", "9845012345"); // the number planted on the attacker's row

  const resolved = await otp.resolveOtpCustomer?.(db, "9845012345")
    ?? await db.prepare("SELECT id FROM canonical_customers WHERE primary_phone=?").bind("9845012345").first();
  assert.ok(!resolved || String(resolved.id) !== "CUST-ATTACKER",
    `the real holder of the number must not resolve to the account that merely claimed it: ${JSON.stringify(resolved)}`);
});

test("W2B-C04: a primary-phone owner is not signed into a neighbour who lists it as secondary", async () => {
  const { db, customer } = await identityWorld();
  const otp = await import("../lib/customer-otp.ts");
  customer("CUST-NEIGHBOUR", "Arjun Neighbour", "9800000001", "9845012345");
  customer("CUST-OWNER", "Meera Owner", "9845012345");

  const resolved = await otp.resolveOtpCustomer(db, "9845012345");
  assert.ok(resolved, "the number's real owner is found");
  assert.equal(String(resolved.id), "CUST-OWNER",
    `the primary-phone owner must win, whatever order the scan reaches the rows in: ${JSON.stringify(resolved)}`);
});

test("W2B-C05: a profile write cannot claim a phone another customer already holds", async () => {
  const { db, account, customer } = await identityWorld();
  customer("CUST-ATTACKER", "Mallory", "9700000001");
  customer("CUST-OWNER", "Meera Owner", "9845012345");

  const attempt = await account.mutateCustomerAccount(db, {
    customerId: "CUST-ATTACKER", action: "update_profile", idempotencyKey: "hijack-1",
    actorId: "CUST-ATTACKER", profile: { secondaryPhone: "9845012345" },
  }).then((value) => ({ ok: true, value }), async (error) => ({
    ok: false, message: error instanceof Response ? await error.clone().text() : String(error?.message ?? error),
  }));
  assert.equal(attempt.ok, false,
    `a number that already belongs to another customer must not be claimable: ${JSON.stringify(attempt)}`);
});

test("W2B-C05: an ordinary profile update still works", async () => {
  // Non-vacuity. Refusing every profile write would satisfy the cases above and break the account page.
  const { sqlite, db, account, customer } = await identityWorld();
  customer("CUST-1", "Ritu", "9700000002");

  const ok = await account.mutateCustomerAccount(db, {
    customerId: "CUST-1", action: "update_profile", idempotencyKey: "ordinary-1",
    actorId: "CUST-1", profile: { secondaryPhone: "9711111111", name: "Ritu Malhotra" },
  }).then((value) => ({ ok: true, value }), async (error) => ({
    ok: false, message: error instanceof Response ? await error.clone().text() : String(error?.message ?? error),
  }));
  assert.equal(ok.ok, true, `a customer may still record their own second number: ${JSON.stringify(ok)}`);
  const row = sqlite.prepare("SELECT name,secondary_phone FROM canonical_customers WHERE id='CUST-1'").get();
  assert.equal(String(row.secondary_phone), "9711111111", "and it is stored");
  assert.equal(String(row.name), "Ritu Malhotra", "along with the rest of the profile");
});

// =====================================================================================================
// Round-2 staging (50-leads-crm, P1): one number, several written forms, several customers.
//
// The web chat stored "+919845012345", the website form whatever the visitor typed, and OTP sign-in matched
// primary_phone EXACTLY on "9845012345". An enquirer stored in another form was not found at sign-in and got a second
// customer, so their booking never reached their lead. Sign-in now treats the forms of one Indian number as that
// number - still on primary_phone only - and a profile claim is refused when another customer holds the number in
// ANY form, or "+91..." could be planted beside a customer holding "98...".
// =====================================================================================================

test("round-2: a customer stored in another written form (+91 98450 12345, 09845012346) still signs in to that customer", async () => {
  const { customer, db } = await identityWorld();
  const otp = await import("../lib/customer-otp.ts");
  customer("CU-CHAT", "Chat Enquirer", "+919845012345");
  customer("CU-FORM", "Form Enquirer", "+91 98450 12346");
  customer("CU-ZERO", "Zero Enquirer", "09845012347");
  for (const [phone, id] of [["9845012345", "CU-CHAT"], ["9845012346", "CU-FORM"], ["9845012347", "CU-ZERO"]]) {
    const resolved = await otp.resolveOtpCustomer(db, phone);
    assert.equal(String(resolved?.id), id, `${phone} must reach the customer stored as another form of it`);
  }
  const request = await otp.requestCustomerOtp(db, { phone: "9845012345" });
  assert.equal(request.existingCustomer, true, "the OTP request knows the customer, so no name is asked and no second customer is made");
});

test("round-2: forms of a number are matched exactly, never a different number sharing its last digits", async () => {
  const { customer, db } = await identityWorld();
  const otp = await import("../lib/customer-otp.ts");
  customer("CU-US", "Different Number", "+1 (984) 501-2345"); // 19845012345: not an Indian form of 9845012345
  customer("CU-SECONDARY", "Only Secondary", "9700000009", "9845012345"); // a secondary is never a login
  assert.equal(await otp.resolveOtpCustomer(db, "9845012345"), null);
});

test("round-2: where one number is already on two customers, sign-in keeps the customer it signed in to before", async () => {
  const { sqlite, customer, db } = await identityWorld();
  const otp = await import("../lib/customer-otp.ts");
  const bindings = await import("../lib/identity-binding.ts");
  const now = Date.now();
  // The staging state: the chat enquiry's customer (older) and the CUS-OTP customer sign-in created beside it.
  customer("CU-CHAT", "Chat Enquirer", "+919845012345");
  sqlite.prepare("UPDATE canonical_customers SET created_at=? WHERE id='CU-CHAT'").run(now - 60_000);
  customer("CUS-OTP-SPLIT", "Chat Enquirer", "9845012345");
  assert.equal(String((await otp.resolveOtpCustomer(db, "9845012345")).id), "CU-CHAT", "never signed in: the oldest (the enquiry's) customer");
  await bindings.upsertIdentityBinding(db, { identitySource: "customer_otp", principalType: "identity_subject", principalKey: "9845012345", subjectType: "customer", subjectId: "CUS-OTP-SPLIT", actorId: "test", reason: "earlier sign-in" });
  assert.equal(String((await otp.resolveOtpCustomer(db, "9845012345")).id), "CUS-OTP-SPLIT", "signed in before: that account, which holds their bookings");
});

test("round-2: a profile claim of another customer's number in a different written form is refused", async () => {
  const { db, account, customer } = await identityWorld();
  customer("CUST-ATTACKER", "Mallory", "9700000001");
  customer("CUST-OWNER", "Meera Owner", "9845012345");
  for (const [field, planted] of [["secondaryPhone", "+91 98450 12345"], ["primaryPhone", "+919845012345"], ["secondaryPhone", "09845012345"]]) {
    const attempt = await account.mutateCustomerAccount(db, { customerId: "CUST-ATTACKER", action: "update_profile", idempotencyKey: `variant-${field}-${planted}`, profile: { [field]: planted } })
      .then(() => ({ ok: true }), async (error) => ({ ok: false, status: error instanceof Response ? error.status : null }));
    assert.deepEqual(attempt, { ok: false, status: 409 }, `${field} ${planted} is 9845012345 and must not be claimable`);
  }
});

test("round-2: a customer whose own number also sits on a split duplicate can still edit their profile", async () => {
  const { sqlite, db, account, customer } = await identityWorld();
  customer("CU-CHAT", "Chat Enquirer", "+919845012345");
  customer("CUS-OTP-SPLIT", "Chat Enquirer", "9845012345");
  const saved = await account.mutateCustomerAccount(db, { customerId: "CUS-OTP-SPLIT", action: "update_profile", idempotencyKey: "rename-1", profile: { name: "Asha Rao" } })
    .then(() => true, async (error) => (error instanceof Response ? `${error.status} ${await error.clone().text()}` : String(error)));
  assert.equal(saved, true, "re-saving the number already on their own record claims nothing");
  assert.equal(sqlite.prepare("SELECT name FROM canonical_customers WHERE id='CUS-OTP-SPLIT'").get().name, "Asha Rao");
});
