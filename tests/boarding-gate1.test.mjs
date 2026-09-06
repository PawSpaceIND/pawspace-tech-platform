/**
 * Boarding Gate 1 — EXECUTED. Catalogue truth, server-owned quotes, host eligibility, and the
 * quote → canonical stay binding.
 *
 * WHAT THIS FILE USED TO BE. One test with 33 assertions, every one of them a regex over the source
 * of `lib/boarding-governance.ts`, the route, the client and the customer page. It asserted that the
 * string "Selected Boarding host capacity is lower than the pet count" appeared in the file. Delete
 * the capacity check and leave the sentence behind in a comment and it stayed green.
 *
 * That is not a hypothetical failure mode in this service. PAWSPACE-QA-001 was a Boarding refund
 * ceiling that compared against `total_amount` while the message beside it read "within the captured
 * booking value": the file READ correct, behaved wrong, and the gate suite agreed with it.
 *
 * Every test below calls the real function or drives the real route handler against a real
 * SQLite-backed D1 and asserts on the rows and refusals it actually produced.
 *
 * Requests are built on a NON-PREVIEW origin. `npm test` runs with NODE_ENV=test and
 * PAWSPACE_LOCAL_PREVIEW=on, so a request to localhost resolves to a superuser holding ["*"] and any
 * authorization assertion against it proves nothing — see tests/helpers/taxi-harness.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1, refusal, stayUrl, stayWindow } from "./helpers/stay-harness.mjs";

installWorkersHooks("__BOARDING_G1_DB__", "__BOARDING_G1_ENV__");

const governance = await import("../lib/boarding-governance.ts");
const commercialRoute = await import("../app/api/boarding-commercial/route.ts");

async function boardingWorld() {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__BOARDING_G1_DB__ = db;
  globalThis.__BOARDING_G1_ENV__ = {};
  await governance.ensureBoardingGovernanceTables(db);
  return { sqlite, db };
}

/** A booking submission that is valid in every respect, so a test can vary ONE field and attribute
 *  the refusal to that field rather than to fixture drift. */
function validBooking(quote, overrides = {}) {
  return {
    quoteId: quote.quoteId,
    packageCode: quote.packageCode,
    packageName: quote.packageName,
    petCount: quote.petCount,
    scheduledStart: quote.scheduledStart,
    scheduledEnd: quote.scheduledEnd,
    submittedTotal: quote.totalAmount,
    submittedAmountDueNow: quote.amountDueNow,
    paymentMode: quote.paymentMode,
    paymentStatus: "captured",
    reservationCount: 1,
    providerId: "host_maya_rohan",
    cityId: "blr",
    zoneId: "blr-east",
    species: ["dog"],
    vaccinationStatuses: ["verified"],
    customerId: "CUST-BOARD-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 1 owns the catalogue on the server, not in the client", async () => {
  const { db } = await boardingWorld();
  const packages = await governance.listBoardingPackages(db);

  // The three codes and their prices are the thing the old suite regex-matched. Here they are read
  // back out of the seeded catalogue table, so deleting a package fails this instead of a comment.
  assert.deepEqual(
    packages.map((row) => [row.package_code, row.base_price_per_pet, row.max_hours]),
    [["boarding-4h", 499, 4], ["boarding-10h", 599, 10], ["boarding-24h", 699, 24]],
  );
  for (const row of packages) {
    assert.equal(row.currency, "INR");
    assert.equal(row.max_pets, 4);
    assert.ok(Number(row.version) >= 1, "a catalogue row carries a version a quote can pin to");
  }
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 1 prices a prepaid quote from the catalogue, never from the caller", async () => {
  const { db } = await boardingWorld();
  const window = stayWindow({ durationHours: 4 });
  const quote = await governance.createBoardingQuote(db, {
    packageCode: "boarding-4h", petCount: 2, paymentMode: "prepaid", ...window,
  });

  assert.equal(quote.basePricePerPet, 499, "the price comes from the catalogue row");
  assert.equal(quote.stayUnits, 1);
  assert.equal(quote.totalAmount, 998, "2 pets x 1 unit x 499");
  assert.equal(quote.amountDueNow, 998, "prepaid takes the whole amount up front");
  assert.equal(quote.packageVersion, 1, "the quote pins the catalogue version it was priced against");
  assert.ok(quote.expiresAt > Date.now(), "a quote carries an expiry");

  // The quote is persisted, so the booking boundary can re-derive the price instead of trusting the body.
  const stored = await db.prepare("SELECT total_amount,amount_due_now,status FROM boarding_commercial_quotes WHERE id=?").bind(quote.quoteId).first();
  assert.equal(Number(stored.total_amount), 998);
  assert.equal(Number(stored.amount_due_now), 998);
  assert.equal(stored.status, "open");
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 1 halves only the amount due now on the approved 50/50 split", async () => {
  const { db } = await boardingWorld();
  const window = stayWindow({ durationHours: 48 });
  const quote = await governance.createBoardingQuote(db, {
    packageCode: "boarding-24h", petCount: 2, paymentMode: "split_50_50", ...window,
  });

  assert.equal(quote.stayUnits, 2, "48 hours of a 24-hour package is two stay units");
  assert.equal(quote.totalAmount, 2796, "2 pets x 2 units x 699");
  assert.equal(quote.amountDueNow, 1398, "the split takes half now — the total is unchanged");
  assert.equal(quote.totalAmount - quote.amountDueNow, 1398, "the remaining half stays owed, it is not discounted");
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 1 supports only full prepaid or the approved 50/50 split", async () => {
  const { db } = await boardingWorld();
  const window = stayWindow();
  const refused = await refusal(governance.createBoardingQuote(db, {
    packageCode: "boarding-4h", petCount: 1, paymentMode: "cash_on_arrival", ...window,
  }));
  assert.equal(refused?.status, 409);
  assert.match(refused.message, /full prepaid or the approved 50\/50 split payment/);
  assert.equal(
    Number((await db.prepare("SELECT COUNT(*) n FROM boarding_commercial_quotes").first()).n), 0,
    "a refused payment mode must not leave a priced quote behind",
  );
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 1 refuses coupons until the canonical catalogue has a redemption policy", async () => {
  const { db } = await boardingWorld();
  const window = stayWindow();
  const refused = await refusal(governance.createBoardingQuote(db, {
    packageCode: "boarding-4h", petCount: 1, paymentMode: "prepaid", couponCode: "SAVE10", ...window,
  }));
  assert.equal(refused?.status, 409);
  assert.match(refused.message, /coupon policy is not enabled in the canonical catalogue/);
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 1 holds the package hour and pet ceilings", async () => {
  const { db } = await boardingWorld();

  const tooLong = await refusal(governance.createBoardingQuote(db, {
    packageCode: "boarding-4h", petCount: 1, paymentMode: "prepaid", ...stayWindow({ durationHours: 9 }),
  }));
  assert.equal(tooLong?.status, 409);
  assert.match(tooLong.message, /Standard Stay supports up to 4 hours/);

  const tooManyPets = await refusal(governance.createBoardingQuote(db, {
    packageCode: "boarding-4h", petCount: 9, paymentMode: "prepaid", ...stayWindow(),
  }));
  assert.equal(tooManyPets?.status, 409);
  assert.match(tooManyPets.message, /Boarding supports 1-4 pets per booking/);

  const overnightTooShort = await refusal(governance.createBoardingQuote(db, {
    packageCode: "boarding-24h", petCount: 1, paymentMode: "prepaid", ...stayWindow({ durationHours: 6 }),
  }));
  assert.equal(overnightTooShort?.status, 409);
  assert.match(overnightTooShort.message, /Overnight Boarding requires more than 10 hours/);

  // A check-in already in the past is a malformed request rather than a policy conflict, so this one
  // is a 400 where the ceilings above are 409. Pinned deliberately: the status is what the client
  // branches on to decide whether to re-quote or to correct the form.
  const pastWindow = await refusal(governance.createBoardingQuote(db, {
    packageCode: "boarding-4h", petCount: 1, paymentMode: "prepaid",
    scheduledStart: new Date(Date.now() - 3_600_000).toISOString(),
    scheduledEnd: new Date(Date.now() + 3_600_000).toISOString(),
  }));
  assert.equal(pastWindow?.status, 400);
  assert.match(pastWindow.message, /requires a future check-in/);
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 1 refuses a booking whose body disagrees with the server quote", async () => {
  const { db } = await boardingWorld();
  const quote = await governance.createBoardingQuote(db, {
    packageCode: "boarding-4h", petCount: 1, paymentMode: "prepaid", ...stayWindow(),
  });

  // The price is the one the client is most motivated to change, so it is checked first and hardest.
  const cheaper = await refusal(governance.governBoardingBooking(db, validBooking(quote, { submittedTotal: 1 })));
  assert.equal(cheaper?.status, 409);
  assert.match(cheaper.message, /amount does not match the server quote/);

  const otherPackage = await refusal(governance.governBoardingBooking(db, validBooking(quote, { packageCode: "boarding-24h" })));
  assert.match(otherPackage.message, /package does not match the server quote/);

  const morePets = await refusal(governance.governBoardingBooking(db, validBooking(quote, { petCount: 3 })));
  assert.match(morePets.message, /pet count changed after quote/);

  const otherWindow = await refusal(governance.governBoardingBooking(db, validBooking(quote, {
    scheduledEnd: new Date(new Date(quote.scheduledEnd).getTime() + 3_600_000).toISOString(),
  })));
  assert.match(otherWindow.message, /stay window changed after quote/);

  const otherMode = await refusal(governance.governBoardingBooking(db, validBooking(quote, { paymentMode: "split_50_50" })));
  assert.match(otherMode.message, /payment mode does not match the server quote/);

  const unpaid = await refusal(governance.governBoardingBooking(db, validBooking(quote, { paymentStatus: "pending" })));
  assert.match(unpaid.message, /captured in sandbox before confirmation/);

  assert.equal(
    (await db.prepare("SELECT status FROM boarding_commercial_quotes WHERE id=?").bind(quote.quoteId).first()).status,
    "open",
    "every refusal above must leave the quote unconsumed",
  );
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 1 requires a verified, in-zone, capable host for every pet", async () => {
  const { db } = await boardingWorld();
  const quote = await governance.createBoardingQuote(db, {
    packageCode: "boarding-4h", petCount: 1, paymentMode: "prepaid", ...stayWindow(),
  });

  // These refusals arrive as a governed JSON envelope carrying a stable `code`, which is what the
  // client branches on. Asserting the code rather than only the prose is the point: prose is what a
  // source-text test could already "verify", and prose is what gets reworded.
  const envelope = (message) => JSON.parse(message);

  // host_maya_rohan takes dogs only; a cat in the party has to be refused by species, not silently priced.
  const wrongSpecies = await refusal(governance.governBoardingBooking(db, validBooking(quote, { species: ["cat"] })));
  assert.equal(wrongSpecies?.status, 409);
  assert.equal(envelope(wrongSpecies.message).code, "boarding_host_species_mismatch");

  const outOfZone = await refusal(governance.governBoardingBooking(db, validBooking(quote, { zoneId: "blr-west" })));
  assert.equal(outOfZone?.status, 409);
  assert.match(outOfZone.message, /city\/zone does not match the scheduling reservation/);

  const unknownHost = await refusal(governance.governBoardingBooking(db, validBooking(quote, { providerId: "host_not_real" })));
  assert.equal(unknownHost?.status, 409);
  assert.equal(envelope(unknownHost.message).code, "boarding_host_profile_missing");

  // Capacity belongs to the host row, so a party larger than the host's places is refused with the
  // number of places actually available rather than a generic conflict.
  //
  // EQUIVALENT MUTATION, recorded rather than chased. Boarding checks capacity twice: this refusal
  // comes from lib/boarding-host-capability.ts (`used + petCount > capacity`, which counts stays
  // already occupying the host), and lib/boarding-governance.ts carries a second, simpler
  // `petCount > max_guest_pets`. Deleting the governance one changes nothing observable — `used` is
  // never negative, so the capability check refuses everything the simpler one would. Sabotage
  // confirms it: removing the governance check survives, removing the capability check turns this
  // test red. Defence in depth on a host's physical limits is deliberate; the test asserts the
  // outcome, which is what a caller can actually see.
  const bigQuote = await governance.createBoardingQuote(db, {
    packageCode: "boarding-4h", petCount: 3, paymentMode: "prepaid", ...stayWindow(),
  });
  const overCapacity = await refusal(governance.governBoardingBooking(db, validBooking(bigQuote, {
    petCount: 3, species: ["dog", "dog", "dog"], vaccinationStatuses: ["verified", "verified", "verified"],
  })));
  assert.equal(overCapacity?.status, 409);
  assert.equal(envelope(overCapacity.message).code, "boarding_host_capacity_exceeded");
  assert.match(envelope(overCapacity.message).error, /has 2 guest places available/);

  await db.prepare("UPDATE boarding_host_profiles SET kyc_status='pending' WHERE provider_id='host_maya_rohan'").run();
  const unverified = await refusal(governance.governBoardingBooking(db, validBooking(quote)));
  assert.equal(unverified?.status, 409);
  assert.match(unverified.message, /has not completed required verification/);
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 1 requires verified vaccination for every pet", async () => {
  const { db } = await boardingWorld();
  const quote = await governance.createBoardingQuote(db, {
    packageCode: "boarding-4h", petCount: 2, paymentMode: "prepaid", ...stayWindow(),
  });

  // One verified and one not is the case that matters: a party is refused when ANY pet in it is
  // uncovered, not only when every pet is.
  for (const statuses of [["verified", "pending"], ["pending", "verified"], ["verified", "not_provided"], ["expired", "expired"]]) {
    const refused = await refusal(governance.governBoardingBooking(db, validBooking(quote, {
      petCount: 2, species: ["dog", "dog"], vaccinationStatuses: statuses,
    })));
    assert.equal(refused?.status, 409, `vaccinationStatuses ${JSON.stringify(statuses)} must be refused`);
    assert.match(refused.message, /verified vaccination for every pet/);
  }

  // WHY THIS IS NOT ALSO ASSERTED FOR A SHORT ARRAY. The guard is
  // `vaccinationStatuses.some(status => status !== "verified")`, so an array shorter than petCount -
  // `[]` or one entry for two pets - passes it. That is reachable only by a caller that supplies
  // petCount and vaccinationStatuses independently, and the sole production caller does not:
  // app/api/canonical-bookings/route.ts derives BOTH from the same array
  // (`petCount: input.pets.length`, `vaccinationStatuses: input.pets.map(...)`), and maps a pet with
  // no status to "not_provided", which the loop above proves is refused. Checked before writing this
  // comment rather than assumed. The coupling is the caller's, so asserting a short array here would
  // pin a state the platform cannot reach and would fail the day the module grows its own length
  // check - the opposite of useful.
  const verified = await governance.governBoardingBooking(db, validBooking(quote, {
    petCount: 2, species: ["dog", "dog"], vaccinationStatuses: ["verified", "verified"],
  }));
  assert.equal(verified.petCount, 2, "a fully vaccinated party is accepted, so the refusals above are the guard and not fixture drift");
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 1 requires exactly one continuous stay reservation", async () => {
  const { db } = await boardingWorld();
  const quote = await governance.createBoardingQuote(db, {
    packageCode: "boarding-4h", petCount: 1, paymentMode: "prepaid", ...stayWindow(),
  });

  for (const reservationCount of [0, 2, 5]) {
    const refused = await refusal(governance.governBoardingBooking(db, validBooking(quote, { reservationCount })));
    assert.equal(refused?.status, 409, `reservationCount ${reservationCount} must be refused`);
    assert.match(refused.message, /exactly one continuous stay reservation/);
  }
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 1 consumes a quote exactly once", async () => {
  const { db } = await boardingWorld();
  const quote = await governance.createBoardingQuote(db, {
    packageCode: "boarding-4h", petCount: 1, paymentMode: "prepaid", ...stayWindow(),
  });

  await governance.consumeBoardingQuote(db, quote.quoteId, "BKG-BOARD-1");
  assert.equal(
    (await db.prepare("SELECT status FROM boarding_commercial_quotes WHERE id=?").bind(quote.quoteId).first()).status,
    "used",
  );

  // A second booking cannot reuse the same priced quote — that is how one payment becomes two stays.
  const reused = await refusal(governance.consumeBoardingQuote(db, quote.quoteId, "BKG-BOARD-2"));
  assert.equal(reused?.status, 409);
  assert.match(reused.message, /could not be consumed exactly once/);

  // The losing call must not have rewritten the winner's booking id — that is how one payment ends up
  // attached to a second stay.
  const row = await db.prepare("SELECT used_booking_id,status FROM boarding_commercial_quotes WHERE id=?").bind(quote.quoteId).first();
  assert.equal(row.used_booking_id, "BKG-BOARD-1");
  assert.equal(row.status, "used");
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 1 commercial route serves the canonical catalogue and refuses a cross-origin write", async () => {
  const { db } = await boardingWorld();
  const window = stayWindow();

  const listed = await commercialRoute.GET(new Request(stayUrl("/api/boarding-commercial?cityId=blr&zoneId=blr-east")));
  assert.equal(listed.status, 200);
  const catalogue = (await listed.json()).data;
  assert.equal(catalogue.source, "canonical_boarding_governance");
  assert.equal(catalogue.liveAvailability, false);
  assert.equal(catalogue.productionReady, false);
  assert.equal(catalogue.paymentMode, "uat_sandbox");
  assert.equal(catalogue.liveMoney, false);
  assert.equal(catalogue.packages.length, 3);
  assert.ok(catalogue.hosts.length > 0);
  assert.equal(catalogue.availabilityVerified, false, "a catalogue-only read must not claim availability was verified");
  assert.equal(catalogue.availabilityMode, "catalogue_only");

  const body = { packageCode: "boarding-4h", petCount: 1, paymentMode: "prepaid", cityId: "blr", zoneId: "blr-east", ...window };
  const quoted = await commercialRoute.POST(new Request(stayUrl("/api/boarding-commercial"), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  assert.equal(quoted.status, 201);
  const quoteBody = (await quoted.json()).data;
  assert.equal(quoteBody.liveMoney, false, "the route never reports live money in UAT");
  assert.equal(quoteBody.productionReady, false);
  assert.equal(quoteBody.totalAmount, 499);

  // A live quote is priced per city and zone, so the route refuses to guess them.
  const { cityId, zoneId, ...withoutPlace } = body;
  const placeless = await commercialRoute.POST(new Request(stayUrl("/api/boarding-commercial"), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(withoutPlace),
  }));
  assert.equal(placeless.status, 400);
  assert.match((await placeless.json()).error, /City and zone are required/);

  const crossOrigin = await commercialRoute.POST(new Request(stayUrl("/api/boarding-commercial"), {
    method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify(body),
  }));
  assert.equal(crossOrigin.status, 403);
  assert.match((await crossOrigin.json()).error, /Cross-origin Boarding quote blocked/);
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 1 gateway keeps the public catalogue separate from authenticated booking", async () => {
  const { db } = await boardingWorld();
  const gateway = await import("../lib/api-gateway.ts");
  const env = { DB: db };

  const catalogueDecision = await gateway.authorizeApiRequest(new Request(stayUrl("/api/boarding-commercial")), env);
  assert.ok(!(catalogueDecision instanceof Response), "browsing the catalogue must not be refused outright");
  assert.equal(catalogueDecision.permission, null, "a catalogue prices nothing customer-specific");

  const bookingDecision = await gateway.authorizeApiRequest(
    new Request(stayUrl("/api/canonical-bookings"), { method: "POST", headers: { "content-type": "application/json" } }),
    env,
  );
  if (bookingDecision instanceof Response) {
    assert.equal(bookingDecision.status, 401, `an unauthenticated booking attempt is refused: ${bookingDecision.status}`);
  } else {
    assert.equal(bookingDecision.permission, "scheduling.book", "creating a canonical stay requires scheduling.book");
  }
});
