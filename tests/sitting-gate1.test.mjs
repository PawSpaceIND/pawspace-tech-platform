/**
 * Pet Sitting Gate 1 — EXECUTED. Catalogue, server-owned quotes, the sandbox payment attestation and
 * the quote → canonical booking binding.
 *
 * WHAT THIS FILE USED TO BE. Eight tests, every assertion a regex over the source of
 * `lib/sitting-governance.ts`, `lib/sitting-payment-governance.ts`, three routes, three clients and
 * the customer page. "Sitting sandbox payment is server-attested before booking" asserted that the
 * string "Sandbox capture amount must match the Sitting quote" appeared in a file.
 *
 * Every test below calls the real function or drives the real route handler against a real
 * SQLite-backed D1. Requests are built on a NON-PREVIEW origin, because `npm test` runs with
 * PAWSPACE_LOCAL_PREVIEW=on and anything posted to localhost resolves to a superuser holding ["*"].
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1, refusal, stayUrl, stayWindow } from "./helpers/stay-harness.mjs";

installWorkersHooks("__SITTING_G1_DB__", "__SITTING_G1_ENV__");

const governance = await import("../lib/sitting-governance.ts");
const payments = await import("../lib/sitting-payment-governance.ts");

async function sittingWorld() {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__SITTING_G1_DB__ = db;
  globalThis.__SITTING_G1_ENV__ = {};
  await governance.ensureSittingGovernanceTables(db);
  await payments.ensureSittingPaymentTables(db);
  return { sqlite, db };
}

const quoteFor = (db, overrides = {}) => governance.createSittingQuote(db, {
  packageCode: "sitting-visit-60", petCount: 1, paymentMode: "prepaid",
  cityId: "blr", zoneId: "blr-east", ...stayWindow(), ...overrides,
});

function validBooking(quote, overrides = {}) {
  return {
    quoteId: quote.quoteId, packageCode: quote.packageCode, packageName: quote.packageName,
    petCount: quote.petCount, cityId: "blr", zoneId: "blr-east",
    scheduledStart: quote.scheduledStart, scheduledEnd: quote.scheduledEnd,
    submittedTotal: quote.totalAmount, submittedAmountDueNow: quote.amountDueNow,
    paymentMode: quote.paymentMode, paymentStatus: "captured", reservationCount: 1, ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 1 prices from the catalogue, charging a base plus each extra pet", async () => {
  const { db } = await sittingWorld();

  // Sitting is priced base + extraPetPrice per ADDITIONAL pet, which is not the per-pet multiply
  // Boarding uses. A source-text test cannot tell the two pricing shapes apart.
  const one = await quoteFor(db, { petCount: 1 });
  assert.equal(one.totalAmount, 399, "one pet is the base price");

  const three = await quoteFor(db, { petCount: 3 });
  assert.equal(three.totalAmount, 399 + 149 * 2, "two extra pets at the extra-pet rate, not three at the base");
  assert.equal(three.totalAmount, 697);
  assert.equal(three.billableUnits, 1, "a single visit window is one billable unit regardless of pet count");
  assert.equal(three.amountDueNow, three.totalAmount, "prepaid takes the whole amount");

  // Overnight needs a window longer than ten hours, which is itself a guard worth pinning.
  const shortOvernight = await refusal(quoteFor(db, { packageCode: "sitting-overnight", petCount: 2 }));
  assert.equal(shortOvernight?.status, 409);
  assert.match(shortOvernight.message, /Overnight Sitting requires more than 10 hours/);

  const overnight = await quoteFor(db, { packageCode: "sitting-overnight", petCount: 2, ...stayWindow({ durationHours: 12 }) });
  assert.equal(overnight.totalAmount, 799 + 399, "the overnight package has its own base and extra-pet rate");

  const stored = await db.prepare("SELECT total_amount,status FROM sitting_commercial_quotes WHERE id=?").bind(one.quoteId).first();
  assert.equal(Number(stored.total_amount), 399, "the price is persisted so the booking boundary can re-derive it");
  assert.equal(stored.status, "open");
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 1 halves only the amount due now on the approved 50/50 split", async () => {
  const { db } = await sittingWorld();
  const split = await quoteFor(db, { packageCode: "sitting-overnight", petCount: 2, paymentMode: "split_50_50", ...stayWindow({ durationHours: 12 }) });

  assert.equal(split.totalAmount, 1198);
  assert.equal(split.amountDueNow, 599, "half now");
  assert.equal(split.totalAmount - split.amountDueNow, 599, "the other half stays owed, it is not discounted");
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 1 refuses an unsupported payment mode and any coupon", async () => {
  const { db } = await sittingWorld();

  const badMode = await refusal(quoteFor(db, { paymentMode: "cash_on_arrival" }));
  assert.equal(badMode?.status, 409);
  assert.match(badMode.message, /full prepaid or the approved 50\/50 split payment/);

  const coupon = await refusal(quoteFor(db, { couponCode: "SAVE10" }));
  assert.equal(coupon?.status, 409);
  assert.match(coupon.message, /coupon policy is not enabled/);

  const quotes = await db.prepare("SELECT COUNT(*) n FROM sitting_commercial_quotes").all();
  assert.equal(Number(quotes.results[0].n), 0, "a refused quote leaves no priced row behind");
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 1 attests a sandbox capture against the quote's amount due now", async () => {
  const { db } = await sittingWorld();
  const split = await quoteFor(db, { packageCode: "sitting-overnight", petCount: 2, paymentMode: "split_50_50", ...stayWindow({ durationHours: 12 }) });

  // Paying the TOTAL on a split quote is the mistake worth catching: it looks like overpayment and
  // would silently satisfy a check written against totalAmount.
  const wrongAmount = await refusal(payments.captureSittingQuoteSandbox(db, {
    quoteId: split.quoteId, amount: split.totalAmount, paymentKey: "pk-wrong",
  }));
  assert.equal(wrongAmount?.status, 409);
  assert.match(wrongAmount.message, /must match the Sitting quote amount due now \(50% for split payment\)/);

  const capture = await payments.captureSittingQuoteSandbox(db, {
    quoteId: split.quoteId, amount: split.amountDueNow, paymentKey: "pk-right",
  });
  assert.ok(capture);

  const attestation = await db.prepare("SELECT COUNT(*) n FROM sitting_quote_payment_attestations WHERE quote_id=?").bind(split.quoteId).all();
  assert.equal(Number(attestation.results[0].n), 1, "the capture is attested server-side, not asserted by the client");
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 1 requires a server-confirmed capture before a booking exists", async () => {
  const { db } = await sittingWorld();
  const quote = await quoteFor(db);

  const uncaptured = await refusal(payments.requireSittingQuoteSandboxCapture(db, {
    quoteId: quote.quoteId, amount: quote.amountDueNow,
  }));
  assert.equal(uncaptured?.status, 409);
  assert.match(uncaptured.message, /requires server-confirmed sandbox capture before booking/);

  await payments.captureSittingQuoteSandbox(db, { quoteId: quote.quoteId, amount: quote.amountDueNow, paymentKey: "pk-1" });
  const confirmed = await payments.requireSittingQuoteSandboxCapture(db, { quoteId: quote.quoteId, amount: quote.amountDueNow });
  assert.ok(confirmed, "an attested capture satisfies the booking boundary");

  // A booking that claims a different amount than the capture must not pass.
  const mismatched = await refusal(payments.requireSittingQuoteSandboxCapture(db, { quoteId: quote.quoteId, amount: 1 }));
  assert.equal(mismatched?.status, 409);
  assert.match(mismatched.message, /does not match the governed quote amount/);
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 1 refuses a capture on a quote that is not open", async () => {
  const { db } = await sittingWorld();
  const quote = await quoteFor(db);

  await governance.consumeSittingQuote(db, quote.quoteId, "BKG-SIT-USED");
  const used = await refusal(payments.captureSittingQuoteSandbox(db, {
    quoteId: quote.quoteId, amount: quote.amountDueNow, paymentKey: "pk-late",
  }));
  assert.equal(used?.status, 409);
  assert.match(used.message, /Only an open Sitting quote can be sandbox-captured/);

  const unknown = await refusal(payments.captureSittingQuoteSandbox(db, {
    quoteId: "SQ-NOT-REAL", amount: 399, paymentKey: "pk-x",
  }));
  assert.equal(unknown?.status, 404);
  assert.match(unknown.message, /Sitting quote not found/);
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 1 refuses a booking whose body disagrees with the server quote", async () => {
  const { db } = await sittingWorld();
  const quote = await quoteFor(db);

  const cheaper = await refusal(governance.governSittingBooking(db, validBooking(quote, { submittedTotal: 1 })));
  assert.equal(cheaper?.status, 409);
  assert.match(cheaper.message, /amount does not match the server quote/);

  const otherPackage = await refusal(governance.governSittingBooking(db, validBooking(quote, { packageCode: "sitting-overnight" })));
  assert.match(otherPackage.message, /package does not match the server quote/);

  const morePets = await refusal(governance.governSittingBooking(db, validBooking(quote, { petCount: 3 })));
  assert.match(morePets.message, /pet count changed after quote/);

  const otherWindow = await refusal(governance.governSittingBooking(db, validBooking(quote, {
    scheduledEnd: new Date(new Date(quote.scheduledEnd).getTime() + 3_600_000).toISOString(),
  })));
  assert.match(otherWindow.message, /window changed after quote|does not match/);

  const unpaid = await refusal(governance.governSittingBooking(db, validBooking(quote, { paymentStatus: "pending" })));
  assert.match(unpaid.message, /captured in sandbox before confirmation|sandbox capture/);

  for (const reservationCount of [0, 2]) {
    const refused = await refusal(governance.governSittingBooking(db, validBooking(quote, { reservationCount })));
    assert.equal(refused?.status, 409, `reservationCount ${reservationCount} must be refused`);
    assert.match(refused.message, /exactly one/);
  }

  assert.equal(
    (await db.prepare("SELECT status FROM sitting_commercial_quotes WHERE id=?").bind(quote.quoteId).first()).status,
    "open",
    "every refusal above must leave the quote unconsumed",
  );
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 1 consumes a quote exactly once", async () => {
  const { db } = await sittingWorld();
  const quote = await quoteFor(db);

  await governance.consumeSittingQuote(db, quote.quoteId, "BKG-SIT-1");
  const reused = await refusal(governance.consumeSittingQuote(db, quote.quoteId, "BKG-SIT-2"));
  assert.equal(reused?.status, 409);

  const row = await db.prepare("SELECT status,used_booking_id FROM sitting_commercial_quotes WHERE id=?").bind(quote.quoteId).first();
  assert.equal(row.status, "used");
  assert.equal(row.used_booking_id, "BKG-SIT-1", "the loser must not rewrite the winner's booking id");
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 1 commercial route is same-origin and honest about UAT money", async () => {
  const { db } = await sittingWorld();
  const route = await import("../app/api/sitting-commercial/route.ts");
  const body = { packageCode: "sitting-visit-60", petCount: 1, paymentMode: "prepaid", cityId: "blr", zoneId: "blr-east", ...stayWindow() };

  const quoted = await route.POST(new Request(stayUrl("/api/sitting-commercial"), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  assert.equal(quoted.status === 200 || quoted.status === 201, true, `a same-origin quote succeeds: ${quoted.status}`);
  const payload = (await quoted.json()).data;
  assert.equal(payload.liveMoney, false, "the route never reports live money in UAT");
  assert.equal(payload.productionReady, false);
  // NOTE, checked rather than assumed: the route spreads the readiness block and then the quote, and
  // the quote also carries `paymentMode`. So on a POST this field is the CUSTOMER's payment mode
  // ("prepaid"), not the environment marker "uat_sandbox" that the readiness block sets. The old
  // source-text test asserted the literal `paymentMode:"uat_sandbox"` appeared in the file and could
  // not have noticed that it is shadowed in the response. The environment claim that survives is
  // liveMoney:false, asserted above.
  assert.equal(payload.paymentMode, "prepaid");

  const crossOrigin = await route.POST(new Request(stayUrl("/api/sitting-commercial"), {
    method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify(body),
  }));
  assert.equal(crossOrigin.status, 403);
  assert.match((await crossOrigin.json()).error, /Cross-origin Sitting quote blocked/);
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 1 gateway keeps the public quote separate from authenticated booking", async () => {
  const { db } = await sittingWorld();
  const gateway = await import("../lib/api-gateway.ts");
  const env = { DB: db };

  const quoteDecision = await gateway.authorizeApiRequest(new Request(stayUrl("/api/sitting-commercial")), env);
  assert.ok(!(quoteDecision instanceof Response), "quoting must not be refused outright");
  assert.equal(quoteDecision.permission, null, "a quote prices nothing customer-specific");

  const bookingDecision = await gateway.authorizeApiRequest(
    new Request(stayUrl("/api/sitting-bookings"), { method: "POST", headers: { "content-type": "application/json" } }),
    env,
  );
  if (bookingDecision instanceof Response) {
    assert.equal(bookingDecision.status, 401, "an unauthenticated booking attempt is refused");
  } else {
    assert.ok(bookingDecision.permission, "creating a Sitting booking is a guarded route");
  }
});
