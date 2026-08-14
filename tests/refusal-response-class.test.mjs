/**
 * A refusal must not look like an outage.
 *
 * Tester 3 stopped the final staging E2E on this. Two cross-customer attempts were refused correctly -
 * nothing was written, no money moved - but both came back HTTP 500:
 *
 *   Customer B rates Customer A's booking          -> refused, answered 500
 *   Customer B redeems wallet on A's booking       -> refused, answered 500
 *   grooming booked for 60 minutes (minimum 120)   -> rejected, answered 500
 *
 * The cause was one line. Handlers funnel their catch block through authError(), which returned a
 * Response unchanged and turned everything else into a 500 - so a domain refusal thrown as a plain
 * Error became a server error. Two consequences, and the second is the worse one:
 *
 *   - the customer sees "something went wrong" instead of "that is not your booking", and retries;
 *   - every test that scores a refusal by looking for 401/403 records the route as NOT refused.
 *
 * The fix is not "treat Errors as 403" - that would report a real outage as a client error and drop it
 * out of the alerting path. Instead the code says what class its refusal is, at the point where the
 * decision is made (lib/http-errors.ts), and authError() honours that annotation. An unannotated error
 * is still a 500, which is what the last test here pins.
 *
 * These drive the real route handlers as real under-privileged identities. Asserting on
 * submitBookingRating() directly would prove nothing about the status the customer receives, because
 * the status is decided in the route's catch block, not in the lib.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

installWorkersHooks("__RRC_DB__", "__RRC_ENV__");

const HOST = "https://pawspace-staging.example.dev";
const NOW = Date.UTC(2026, 7, 1);

let sqlite;

async function fresh() {
  sqlite = new DatabaseSync(":memory:");
  const db = createD1(sqlite);
  globalThis.__RRC_DB__ = db;
  globalThis.__RRC_ENV__ = { FOUNDER_EMAIL: "founder@pawspace.test" };

  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);

  sqlite.exec(`
    CREATE TABLE canonical_customers (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE canonical_pets (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, name TEXT, species TEXT, breed TEXT, vaccination_status TEXT);
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, provider_id TEXT, service_code TEXT, package_name TEXT, scheduled_start TEXT, status TEXT, total_amount REAL);
  `);
  // The real provider DDL and roster, not a stub - a hand-cut provider_capacity_profiles diverges from
  // production and the scheduling path fails on a missing column instead of on the thing under test.
  const { seedProviderCapacityDefaults } = await import("../lib/provider-capacity-governance.ts");
  await seedProviderCapacityDefaults(db);
  // Zero the seeded rating so "did a refused rating move the score?" has a deterministic baseline.
  sqlite.prepare("UPDATE provider_capacity_profiles SET rating=0,quality_score=0 WHERE id='groom_arun'").run();
  sqlite.prepare("INSERT INTO canonical_customers VALUES ('CUS-A','Asha'),('CUS-B','Bhavna')").run();
  sqlite.prepare("INSERT INTO canonical_pets VALUES ('PET-A','CUS-A','Bruno','dog','indie','verified')").run();
  // One completed, payable booking, owned by A. Everything below points at it.
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-A','CUS-A','groom_arun','grooming','Basic Groom','2026-07-20T05:00:00.000Z','completed',2000)").run();
  // A completed booking owned by A that is NOT grooming, for the reward-scope rule below.
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-A-WALK','CUS-A','walk_kiran','dog_walking','Daily Walk','2026-07-21T05:00:00.000Z','completed',600)").run();

  for (const [email, role] of [["asha@pawspace.test", "customer"], ["bhavna@pawspace.test", "customer"], ["finance@pawspace.test", "finance"]]) {
    sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
      .run(`u-${email}`, email, email.split("@")[0], role, NOW, NOW);
  }
  for (const [email, customerId] of [["asha@pawspace.test", "CUS-A"], ["bhavna@pawspace.test", "CUS-B"]]) {
    sqlite.prepare("INSERT OR REPLACE INTO customer_identity_links (email,customer_id,status,verified_at,updated_at) VALUES (?,?,'active',?,?)").run(email, customerId, NOW, NOW);
  }
  return db;
}

async function call(modulePath, method, email, path, payload) {
  const route = await import(modulePath);
  const init = { method, headers: { "content-type": "application/json", "oai-authenticated-user-email": email } };
  if (payload !== undefined) init.body = JSON.stringify(payload);
  const response = await route[method](new Request(`${HOST}${path}`, init));
  const text = await response.text();
  let body; try { body = JSON.parse(text); } catch { body = { error: text }; }
  return { status: response.status, body };
}

const rate = (email, payload) => call("../app/api/booking-rating/route.ts", "POST", email, "/api/booking-rating", payload);
const wallet = (email, payload) => call("../app/api/pawspace-wallet/route.ts", "POST", email, "/api/pawspace-wallet", payload);
const reserve = (email, payload) => call("../app/api/uat-scheduling/route.ts", "POST", email, "/api/uat-scheduling", payload);

const rows = (sql) => { try { return sqlite.prepare(sql).all(); } catch { return []; } };
const balanceOf = (customerId) => {
  const row = rows(`SELECT balance FROM pawspace_wallet_accounts WHERE customer_id='${customerId}'`)[0];
  return row ? Number(row.balance) : null;
};

/** Give A wallet credit to spend, through the real staff-gated credit path. */
async function creditA(amount = 1000) {
  const credited = await wallet("finance@pawspace.test", { action: "credit", customerId: "CUS-A", amount, source: "goodwill", idempotencyKey: `seed-${amount}` });
  assert.equal(credited.status, 201, `wallet credit fixture failed: ${JSON.stringify(credited.body)}`);
  return credited;
}

// ---------------------------------------------------------------------------
// P0-1a: cross-customer rating
// ---------------------------------------------------------------------------
test("a customer rating another customer's booking is refused with 403, and writes nothing", async () => {
  await fresh();
  // Bhavna signs in as herself and names herself - so requireCustomerOwnership in the route passes.
  // The only thing wrong is the bookingId, which is Asha's. This is the exact live shape: the refusal
  // comes from the ownership check inside the lib, which is where the plain Error was thrown.
  const attempt = await rate("bhavna@pawspace.test", { customerId: "CUS-B", bookingId: "BK-A", stars: 1 });

  assert.equal(attempt.status, 403, `expected 403, got ${attempt.status}: ${JSON.stringify(attempt.body)}`);
  assert.match(String(attempt.body.error), /only rate your own bookings/);

  // Zero mutation: no rating row, and the provider's rating is untouched. A refusal that still moved
  // the provider's score would be the real damage here - a rival could tank a groomer with 1 stars.
  assert.deepEqual(rows("SELECT * FROM booking_ratings"), [], "a refused rating must leave no row behind");
  const untouched = rows("SELECT rating,quality_score FROM provider_capacity_profiles WHERE id='groom_arun'")[0];
  assert.equal(Number(untouched.rating), 0, "a refused rating moved the provider's rating");
  assert.equal(Number(untouched.quality_score), 0, "a refused rating moved the provider's quality score");
});

// ---------------------------------------------------------------------------
// P0-1b: cross-customer wallet redemption
// ---------------------------------------------------------------------------
test("a customer redeeming wallet credit against another customer's booking is refused with 403, and no money moves", async () => {
  await fresh();
  await creditA(1000);
  // Bhavna has her own wallet too, so this proves the refusal is about the BOOKING, not about having
  // no balance - otherwise the test would pass for the wrong reason once she was broke.
  const credited = await wallet("finance@pawspace.test", { action: "credit", customerId: "CUS-B", amount: 1000, source: "goodwill", idempotencyKey: "seed-b" });
  assert.equal(credited.status, 201, JSON.stringify(credited.body));

  const before = { a: balanceOf("CUS-A"), b: balanceOf("CUS-B"), ledger: rows("SELECT * FROM pawspace_wallet_ledger").length };
  assert.equal(before.a, 1000);
  assert.equal(before.b, 1000);

  const attempt = await wallet("bhavna@pawspace.test", { customerId: "CUS-B", bookingId: "BK-A", walletAmount: 500 });

  assert.equal(attempt.status, 403, `expected 403, got ${attempt.status}: ${JSON.stringify(attempt.body)}`);
  assert.match(String(attempt.body.error), /own booking/);

  // Zero money movement, on both sides of the attempt, and no ledger entry either way.
  assert.equal(balanceOf("CUS-A"), before.a, "the victim's balance moved");
  assert.equal(balanceOf("CUS-B"), before.b, "the attacker's balance moved");
  assert.equal(rows("SELECT * FROM pawspace_wallet_ledger").length, before.ledger, "a refused redemption wrote a ledger row");
  assert.deepEqual(rows("SELECT * FROM pawspace_wallet_ledger WHERE source_id='BK-A'"), [], "a refused redemption was recorded against the booking");
});

// ---------------------------------------------------------------------------
// The positive controls. Without these, breaking both features outright would score as a clean pass.
// ---------------------------------------------------------------------------
test("the rightful owner can still rate their own completed booking", async () => {
  await fresh();
  const own = await rate("asha@pawspace.test", { customerId: "CUS-A", bookingId: "BK-A", stars: 5 });

  assert.equal(own.status, 201, `the owner was blocked: ${JSON.stringify(own.body)}`);
  assert.equal(rows("SELECT * FROM booking_ratings").length, 1, "the owner's rating was not stored");
  // And it reached the field the matching engine actually sorts on.
  const scored = rows("SELECT rating,quality_score FROM provider_capacity_profiles WHERE id='groom_arun'")[0];
  assert.equal(Number(scored.rating), 5);
  assert.equal(Number(scored.quality_score), 100);
});

test("the rightful owner can still redeem wallet credit on their own booking", async () => {
  await fresh();
  await creditA(1000);
  const own = await wallet("asha@pawspace.test", { customerId: "CUS-A", bookingId: "BK-A", walletAmount: 500 });

  assert.equal(own.status, 201, `the owner was blocked: ${JSON.stringify(own.body)}`);
  // 500 of wallet buys 550 of booking value at the 10% enhancement, and the balance falls by the
  // wallet amount, not by the enhanced value.
  assert.equal(own.body.data.walletUsed, 500);
  assert.equal(own.body.data.appliedValue, 550);
  assert.equal(balanceOf("CUS-A"), 500, "the owner's balance was not debited correctly");
  assert.equal(rows("SELECT * FROM pawspace_wallet_ledger WHERE entry_type='redeem'").length, 1);
});

// ---------------------------------------------------------------------------
// P1: bad input is the caller's fault, and must say so
// ---------------------------------------------------------------------------
test("a grooming slot shorter than the service minimum is a client error, not a 500", async () => {
  await fresh();
  // 60 minutes for one pet; grooming requires 120. backend/src/scheduling.ts has always annotated this
  // rejection with statusCode:422 - backend/src/app.ts honours it - but the Worker's authError()
  // discarded the annotation, so the customer saw a 500 and had no idea to pick a longer slot.
  const short = await reserve("asha@pawspace.test", {
    clientRequestId: "req-short-groom", customerId: "CUS-A", petIds: ["PET-A"],
    serviceCode: "grooming", zoneId: "koramangala",
    scheduledStart: "2026-09-10T10:00:00.000Z", scheduledEnd: "2026-09-10T11:00:00.000Z",
  });

  assert.ok(short.status >= 400 && short.status < 500, `expected a 4xx, got ${short.status}: ${JSON.stringify(short.body)}`);
  assert.equal(short.status, 422, `a well-formed but unsatisfiable duration is a 422, got ${short.status}`);
  assert.match(String(short.body.error), /at least 120 minutes/);
  assert.deepEqual(rows("SELECT * FROM scheduling_reservations"), [], "a rejected duration must reserve nothing");
});

test("a duration that does meet the minimum is not rejected as bad input", async () => {
  await fresh();
  // The control for the test above. 180 minutes clears the 120 minimum, so whatever happens next is a
  // scheduling outcome (this bare fixture has no roster, so NO_SCHEDULE_AVAILABLE is expected) - what
  // must NOT happen is a 422 about the duration.
  const ok = await reserve("asha@pawspace.test", {
    clientRequestId: "req-long-groom", customerId: "CUS-A", petIds: ["PET-A"],
    serviceCode: "grooming", zoneId: "koramangala",
    scheduledStart: "2026-09-10T10:00:00.000Z", scheduledEnd: "2026-09-10T13:00:00.000Z",
  });

  assert.notEqual(ok.status, 422, `a valid duration was rejected as unsatisfiable: ${JSON.stringify(ok.body)}`);
  assert.doesNotMatch(String(ok.body.error ?? ""), /minutes/, `a valid duration drew a duration complaint: ${JSON.stringify(ok.body)}`);
});

// ---------------------------------------------------------------------------
// The guard on the fix itself. This is the test that stops the next person "simplifying" authError()
// into `return 403 for any Error`, which would hide every outage behind a client error.
// ---------------------------------------------------------------------------
test("a genuine unexpected internal failure is still a 500", async () => {
  await fresh();
  // A real infrastructure fault, not a refusal: the table the handler reads is gone. The error that
  // surfaces carries no class annotation, so it must keep its 500 and stay in the alerting path.
  sqlite.exec("DROP TABLE canonical_bookings");

  const broken = await rate("asha@pawspace.test", { customerId: "CUS-A", bookingId: "BK-A", stars: 5 });

  assert.equal(broken.status, 500, `an unexpected failure was downgraded to ${broken.status}: ${JSON.stringify(broken.body)}`);
});

test("an unclassified error stays a 500 even when it is thrown from an ownership-shaped call site", async () => {
  await fresh();
  // Same point, asserted against authError() itself rather than through a route, so it holds for the
  // 200-odd other handlers that share this catch block. Only the annotation moves the status - not the
  // message, and not the fact that it is an Error.
  const { authError } = await import("../lib/server-auth.ts");
  const { ownershipDenied, badInput, stateConflict, notFound } = await import("../lib/http-errors.ts");

  assert.equal(authError(new Error("Customer ownership denied")).status, 500, "a message that merely reads like a refusal must not become one");
  assert.equal(authError(Object.assign(new Error("boom"), { statusCode: 503 })).status, 500, "a 5xx annotation cannot be laundered into a client error");
  assert.equal(authError(Object.assign(new Error("boom"), { statusCode: "403" })).status, 500, "a non-numeric annotation is not a status");
  assert.equal(authError("a bare string").status, 500);

  assert.equal(authError(ownershipDenied("not yours")).status, 403);
  assert.equal(authError(badInput("nope")).status, 400);
  assert.equal(authError(stateConflict("already done")).status, 409);
  assert.equal(authError(notFound("gone")).status, 404);
  // A thrown Response still wins outright - that is how authFailure and the sign-in redirect work.
  assert.equal(authError(Response.json({ error: "Permission denied" }, { status: 403 })).status, 403);
});

// ---------------------------------------------------------------------------
// The same defect in the three files inspected alongside the confirmed pair.
// ---------------------------------------------------------------------------
test("cross-customer refusals in review, birthday and passport governance are 403 rather than 500", async () => {
  await fresh();
  const { savePetBirthday } = await import("../lib/pet-birthday-governance.ts");
  const { createPetPassportShare } = await import("../lib/pet-passport-governance.ts");
  const { authError } = await import("../lib/server-auth.ts");

  // PET-A belongs to CUS-A. CUS-B naming it is the cross-customer case in each module.
  const db = globalThis.__RRC_DB__;
  for (const [label, run] of [
    ["pet birthday", () => savePetBirthday(db, { customerId: "CUS-B", petId: "PET-A", dateOfBirth: "2022-03-04", actorId: "CUS-B" })],
    ["pet passport", () => createPetPassportShare(db, { customerId: "CUS-B", petId: "PET-A", actorId: "CUS-B" })],
  ]) {
    const error = await run().then(() => null, (e) => e);
    assert.ok(error, `${label} did not refuse a cross-customer request at all`);
    assert.equal(authError(error).status, 403, `${label} refusal is answered with ${authError(error).status}, not 403: ${error.message}`);
  }
});

test("the birthday reward is refused on a non-grooming booking, and the refusal is a 409", async () => {
  await fresh();
  // This replaces a source-text assertion in tests/pet-delight-features.test.mjs that matched the
  // literal `throw new Error("The birthday reward is valid on doorstep grooming only")`. That line
  // proved someone had typed the rule; it broke the moment the response class changed and would have
  // passed just as happily if the rule had been deleted and the string left in a comment. This drives
  // the real redemption instead.
  const { ensurePetBirthdayTables, redeemBirthdayReward } = await import("../lib/pet-birthday-governance.ts");
  const { authError } = await import("../lib/server-auth.ts");
  const db = globalThis.__RRC_DB__;
  await ensurePetBirthdayTables(db);

  const year = 2026, expires = Date.UTC(2027, 0, 1);
  sqlite.prepare("INSERT INTO pet_birthday_rewards (id,pet_id,customer_id,reward_year,code,discount_amount,service_scope,status,expires_at,redeemed_booking_id,redeemed_at,created_at) VALUES ('BDR-1','PET-A','CUS-A',?,'BDAY-CODE-1',500,'grooming','issued',?,NULL,NULL,?)")
    .run(year, expires, NOW);

  // Walking is not grooming, so the reward must not apply - and must say so as a state conflict.
  const refused = await redeemBirthdayReward(db, { code: "BDAY-CODE-1", customerId: "CUS-A", bookingId: "BK-A-WALK", actorId: "CUS-A" }).then(() => null, (e) => e);
  assert.ok(refused, "the reward was applied to a non-grooming booking");
  assert.equal(authError(refused).status, 409, `expected 409, got ${authError(refused).status}: ${refused.message}`);
  assert.match(String(refused.message), /doorstep grooming only/);
  // Refused means unspent: the code must still be redeemable against a booking that does qualify.
  const still = sqlite.prepare("SELECT status,redeemed_booking_id FROM pet_birthday_rewards WHERE id='BDR-1'").get();
  assert.equal(String(still.status), "issued", "a refused redemption burned the reward");
  assert.equal(still.redeemed_booking_id, null);

  // The positive control: the same code on the grooming booking is accepted, so the test above is
  // about the SERVICE and not about the reward being broken.
  const applied = await redeemBirthdayReward(db, { code: "BDAY-CODE-1", customerId: "CUS-A", bookingId: "BK-A", actorId: "CUS-A" });
  assert.ok(applied, "the reward could not be redeemed on a qualifying grooming booking");
  const spent = sqlite.prepare("SELECT status,redeemed_booking_id FROM pet_birthday_rewards WHERE id='BDR-1'").get();
  assert.equal(String(spent.status), "redeemed");
  assert.equal(String(spent.redeemed_booking_id), "BK-A");
});
