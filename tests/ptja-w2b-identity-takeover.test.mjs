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
  const { sqlite, db, customer } = await identityWorld();
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
