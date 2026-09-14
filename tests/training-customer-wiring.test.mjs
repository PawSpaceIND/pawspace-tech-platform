import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setupJourney, routeCall, sessionCookie } from "./helpers/grooming-journey-harness.mjs";
import { seedOwnedPet } from "./helpers/saved-pet-fixture.mjs";

/*
 * Work Order 02. The customer Training route's contracts are executed where they are enforced - the
 * server. Ownership of the reservation subject, the server-quote requirement, and the refusal to turn a
 * client-declared capture into a confirmed booking are proven against real D1 through the real routes.
 * The page tokens that describe which client helpers are wired stay as source pins next to that proof.
 */
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const { createTrainingQuote } = await import("../lib/training-commercial-governance.ts");

async function world(t) {
  const ctx = await setupJourney(); t.after(ctx.close);
  const customerId = "CUST-TRAIN-WIRE", petId = "PET-TRAIN-WIRE";
  await seedOwnedPet(ctx.db, customerId, petId, "Bruno");
  const cookie = await sessionCookie(ctx.db, "customer", customerId, `customer:${customerId}`);
  const start = new Date(Date.now() + 6 * 86400000); start.setUTCHours(5, 30, 0, 0);
  const end = new Date(start.getTime() + 60 * 60_000);
  const schedule = (over = {}) => ({ clientRequestId: "TRAIN-WIRE-1", customerId, petIds: [petId], serviceCode: "dog_training", cityId: "blr", zoneId: "blr-east", serviceAddress: "Bruno home, Indiranagar 560038", servicePincode: "560038", scheduledStart: start.toISOString(), scheduledEnd: end.toISOString(), preferredProviderId: "train_kiran", occurrences: 2, cadenceDays: 7, ...over });
  return { ctx, customerId, petId, cookie, start, end, schedule };
}
const scheduling = (body, cookie) => routeCall("../../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", body, cookie);
const booking = (body, cookie) => routeCall("../../app/api/canonical-bookings/route.ts", "POST", "/api/canonical-bookings", body, cookie);

test("the Training route books for the signed-in customer only: the session gateway refuses another subject", async (t) => {
  const { ctx, cookie, schedule } = await world(t);
  const forged = await scheduling(schedule({ customerId: "TST-101", petIds: ["TST-PET-BRUNO"] }), cookie);
  assert.equal(forged.status, 403, JSON.stringify(forged.body));
  const reservationsTable = ctx.sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='scheduling_reservations'").get().n;
  assert.equal(reservationsTable ? ctx.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations").get().n : 0, 0, "a refused subject holds nothing");
  const own = await scheduling(schedule(), cookie);
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(own.body.data.provider.id, "train_kiran");
  assert.ok(ctx.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations WHERE group_id=? AND service_code='dog_training' AND status!='cancelled'").get(own.body.data.groupId).n >= 1);
  const page = await read("app/training/page.tsx");
  const code = page.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  for (const fixture of ["TST-101", "TST-PET-BRUNO", "TST-PET-PEPPER", "uat.customer@pawspace.test"]) assert.equal(code.includes(fixture), false, `hardcoded fixture ${fixture} must not be booked on behalf of a real customer`);
  for (const token of ["loadCustomerAccount", "account.customerId", "pet.sourceId??pet.id", 'pet.species==="dog"', "const petCount=selectedPets.length"]) assert.equal(page.includes(token), true, token);
});


async function reservedQuote(t) {
  const w = await world(t);
  const reserved = await scheduling(w.schedule(), w.cookie);
  assert.equal(reserved.status, 200, JSON.stringify(reserved.body));
  const groupId = reserved.body.data.groupId, provider = reserved.body.data.provider;
  const first = w.ctx.sqlite.prepare("SELECT scheduled_start,scheduled_end FROM scheduling_reservations WHERE group_id=? ORDER BY occurrence_number LIMIT 1").get(groupId);
  const quote = await createTrainingQuote(w.ctx.db, { packageCode: "training-2-starter", petCount: 1, scheduledStart: first.scheduled_start, paymentMode: "split" });
  const packageName = w.ctx.sqlite.prepare("SELECT p.name FROM training_commercial_quotes q JOIN training_commercial_packages p ON p.package_code=q.package_code AND p.version=q.package_version WHERE q.id=?").get(quote.quoteId).name;
  const payload = (over = {}) => ({
    idempotencyKey: `training:${quote.quoteId}:${w.customerId}`, scheduleGroupId: groupId,
    customer: { id: w.customerId, name: "Demo Customer", primaryPhone: "9812345678" },
    pets: [{ sourceId: w.petId, name: "Bruno", species: "dog", breed: "Labrador Retriever", vaccinationStatus: "verified" }],
    cityId: "blr", zoneId: "blr-east", serviceCode: "dog_training", packageCode: "training-2-starter", packageName,
    scheduledStart: first.scheduled_start, scheduledEnd: first.scheduled_end, provider,
    totalAmount: quote.totalAmount, amountDueNow: quote.amountDueNow,
    payment: { method: "internal_uat", mode: quote.paymentMode, status: "created", detail: "UAT Training checkout" },
    pricing: { discount: 0, trainingQuoteId: quote.quoteId }, ...over,
  });
  return { ...w, quote, payload };
}

test("a client-declared capture never confirms a Training booking: the server records it as created and waits for the gateway", async (t) => {
  const { ctx, cookie, quote, payload } = await reservedQuote(t);
  const claimed = await booking(payload({ payment: { method: "internal_uat", mode: quote.paymentMode, status: "captured", detail: "Training UAT sandbox capture marker" } }), cookie);
  assert.equal(claimed.status, 201, JSON.stringify(claimed.body));
  assert.equal(claimed.body.data.status, "payment_pending", "a caller-declared capture must not confirm the booking");
  const row = ctx.sqlite.prepare("SELECT b.status booking_status,p.status payment_status,p.method FROM canonical_bookings b JOIN booking_payments p ON p.booking_id=b.id WHERE b.id=?").get(claimed.body.data.bookingId);
  assert.deepEqual({ ...row }, { booking_status: "payment_pending", payment_status: "created", method: "internal_uat" });
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings WHERE status='confirmed' AND service_code='dog_training'").get().n, 0);
  // The same claim through any other unproven method is demoted the same way: the method never decides.
  const cash = await booking(payload({ idempotencyKey: `training:${quote.quoteId}:cash`, payment: { method: "cash", mode: quote.paymentMode, status: "captured", detail: "claimed cash" } }), cookie);
  assert.ok([200, 409].includes(cash.status), JSON.stringify(cash.body));
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM booking_payments WHERE status='captured'").get().n, 0);
});

test("a Training booking needs a server quote and starts payment_pending on the honest client path", async (t) => {
  const { ctx, cookie, quote, payload } = await reservedQuote(t);
  const unquoted = await booking(payload({ pricing: { discount: 0 } }), cookie);
  assert.equal(unquoted.status, 409, JSON.stringify(unquoted.body));
  assert.match(unquoted.body.error, /server Training quote is required/);

  const created = await booking(payload(), cookie);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.status, "payment_pending", "the honest client path starts payment_pending and waits for the gateway");
  assert.equal(ctx.sqlite.prepare("SELECT status FROM booking_payments WHERE booking_id=?").get(created.body.data.bookingId).status, "created");
  assert.equal(ctx.sqlite.prepare("SELECT status,used_booking_id FROM training_commercial_quotes WHERE id=?").get(quote.quoteId).status, "used", "the quote is consumed by the booking, not by the client");
  const replay = await booking(payload(), cookie);
  assert.equal(replay.body.data.bookingId, created.body.data.bookingId);
  assert.equal(replay.body.data.duplicatePrevented, true);

  // The client sends exactly what the server just refused to trust: an unproven "created" payment.
  const client = await read("lib/training-booking-client.ts");
  for (const token of ["createCanonicalLifecycle", 'serviceCode:"dog_training"', "trainingQuoteId:quote.quoteId", "liveMoney:false"]) assert.equal(client.includes(token), true, token);
  assert.match(client, /payment:\{method:"internal_uat",mode:quote\.paymentMode,status:"created"/);
  const lifecycle = await read("lib/canonical-lifecycle-client.ts");
  assert.equal(lifecycle.includes("/api/training-payment-sandbox"), false, "booking creation must not manufacture a Training capture");
  for (const path of ["app/mobile-app/training-flow.tsx", "app/training/page.tsx"]) assert.equal((await read(path)).includes("BookingPaymentPage"), true, `${path} sends the customer through the shared payment page`);
  assert.equal((await read("app/mobile-app/training-flow.tsx")).includes("bookingId={pendingPayment.bookingId}"), true);
});

test("the Training page reserves the server-governed session count and never leaves the confirm button as a dead end", async () => {
  const page = await read("app/training/page.tsx");
  for (const token of ["loadTrainingPackages", "quoteTraining", "loadTrainingTrainers", "reserveUatSchedule", "createCanonicalTrainingBooking", "materializeTrainingProgramme", "programme.sessions", "Canonical scheduler assignment", "occurrences:quote.meetAndGreet?1:quote.sessions", "cadenceDays:7", "quote.minutesPerSession", "currentQuote.amountDueNow", "petCount===0", "No dogs on your profile yet", "Select at least one of your dogs to continue", "petCount>0?quoteTraining"]) assert.equal(page.includes(token), true, token);
});
