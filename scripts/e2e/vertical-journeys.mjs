#!/usr/bin/env node
/*
 * Drive EVERY service vertical against a running hardened server, and say where each one stops.
 *
 * The browser journeys under e2e/journeys cover one vertical end to end - 04-multi-actor drives
 * grooming, twice. Everything else was covered at the engine level by tests/, which is real coverage
 * but does not answer "does the real Worker, the real gateway and a real D1 carry this vertical from
 * a quote to a booking a staff member can see". This does, and it found two defects the engine tests
 * could not: a one-off dog walk died as a TypeError inside governWalkingBooking because no fixture
 * ever OMITTED the weekday pattern the way a browser does, and Doorstep Vet was published to
 * customers as bookable with no provider anywhere able to take it.
 *
 * Usage:  bash scripts/e2e/serve-hardened.sh &   # then, once it answers
 *         node scripts/e2e/seed-identities.mjs
 *         node scripts/e2e/vertical-journeys.mjs
 *
 * Every refusal printed below is the SERVER's own sentence. A FAIL line is therefore either a defect
 * or a payload this driver got wrong, and the message says which - that is the point of printing it
 * rather than an assertion count.
 */
const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:8788";
const CUSTOMER = "e2e.customer@pawspace.test", ADMIN = "e2e.admin@pawspace.test";
const ADMIN_MFA = "pawspace_admin_mfa=e2e-admin-mfa-session-token";
const CUSTOMER_ID = "E2E-CUS-UI-001", PET_ID = "E2E-PET-UI-001";

const call = async (method, path, { email = CUSTOMER, cookie, body } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "oai-authenticated-user-email": email, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text: text.slice(0, 240) };
};
const get = (p, o) => call("GET", p, o), post = (p, body, o = {}) => call("POST", p, { ...o, body });
const staff = { email: ADMIN, cookie: ADMIN_MFA };

/* A window far enough out to be bookable, and randomised so a re-run does not collide with the
   reservations the previous run left behind - capacity of one is correctly enforced. */
const windowOf = (hours) => {
  const start = new Date(Date.now() + (20 + Math.floor(Math.random() * 90)) * 86_400_000);
  start.setUTCHours(4, 30, 0, 0);
  return { scheduledStart: start.toISOString(), scheduledEnd: new Date(start.getTime() + hours * 3_600_000).toISOString() };
};
const tag = (v) => `VJ-${v.toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
const CUSTOMER_BLOCK = { id: CUSTOMER_ID, name: "E2E Customer", primaryPhone: "+919800000077" };
const PETS = [{ sourceId: PET_ID, name: "Bruno", species: "dog", vaccinationStatus: "verified" }];
/* Pet Sitting captures address evidence when the slot is RESERVED and reads it back at booking, so a
   booking can never carry an address the scheduler never saw. */
const ADDRESS = { serviceAddress: "221B Indiranagar 100ft Road, Bengaluru", servicePincode: "560038", latitude: 12.9784, longitude: 77.6408 };

const results = [];
const journey = (vertical) => {
  const steps = [];
  return {
    steps,
    ok: (name, r, accept = (x) => x.status < 400) => {
      const good = accept(r);
      steps.push({ name, status: r.status, good, detail: good ? "" : JSON.stringify(r.body ?? r.text).slice(0, 220) });
      return good;
    },
    done: () => { results.push({ vertical, steps }); },
  };
};
const bookingIdOf = (r) => r.body?.data?.booking?.id ?? r.body?.data?.bookingId ?? "";

async function grooming() {
  const j = journey("grooming"), w = windowOf(2), groupId = tag("groom");
  const rv = await post("/api/uat-scheduling", { action: "reserve", assignmentStrategy: "auto", clientRequestId: groupId,
    customerId: CUSTOMER_ID, petIds: [PET_ID], serviceCode: "grooming", cityId: "blr", zoneId: "blr-east", ...w });
  if (!j.ok("reserve slot", rv)) return j.done();
  j.ok("staff ops", await get("/api/booking-command-center", staff));
  j.done();
}

async function training() {
  const j = journey("dog_training"), w = windowOf(1);
  const trainers = await get("/api/training-trainers?cityId=blr&zoneId=blr-east");
  if (!j.ok("discover trainers", trainers)) return j.done();
  const trainer = trainers.body.data.providers[0];
  const q = await post("/api/training-commercial", { action: "quote", packageCode: "training-2-starter", petCount: 1,
    scheduledStart: w.scheduledStart, paymentMode: "prepaid", cityId: "blr", zoneId: "blr-east" });
  if (!j.ok("server quote", q)) return j.done();
  const quote = q.body.data, groupId = tag("train");
  const rv = await post("/api/uat-scheduling", { action: "reserve", assignmentStrategy: "auto", clientRequestId: groupId,
    customerId: CUSTOMER_ID, petIds: [PET_ID], serviceCode: "dog_training", cityId: "blr", zoneId: "blr-east", ...w,
    preferredProviderId: trainer.id, occurrences: quote.sessions, cadenceDays: 7,
    weekdays: [new Date(w.scheduledStart).getUTCDay()] });
  if (!j.ok(`reserve ${quote.sessions} sessions`, rv)) return j.done();
  const p = rv.body.data.provider;
  j.ok("book", await post("/api/canonical-bookings", { idempotencyKey: `${groupId}-bk`, scheduleGroupId: groupId,
    customer: CUSTOMER_BLOCK, pets: PETS, cityId: "blr", zoneId: "blr-east", serviceCode: "dog_training",
    packageCode: quote.packageCode, packageName: quote.packageName, ...w,
    provider: { id: p.id, name: p.name, model: p.model }, totalAmount: quote.totalAmount, amountDueNow: quote.amountDueNow,
    payment: { method: "upi", mode: quote.paymentMode, status: "captured", detail: "vertical journey" },
    pricing: { discount: 0, trainingQuoteId: quote.quoteId } }));
  j.ok("staff ops", await get("/api/training-ops", staff));
  j.done();
}

async function sitting() {
  const j = journey("pet_sitting"), w = windowOf(6);
  const pv = await post("/api/uat-scheduling", { action: "preview", clientRequestId: tag("sit"), customerId: CUSTOMER_ID,
    petIds: [PET_ID], serviceCode: "pet_sitting", cityId: "blr", zoneId: "blr-east", ...w });
  if (!j.ok("discover sitters", pv)) return j.done();
  const sitter = pv.body.data.providers[0];
  const q = await post("/api/sitting-commercial", { packageCode: "sitting-visit-60", petCount: 1, paymentMode: "prepaid",
    cityId: "blr", zoneId: "blr-east", providerId: sitter.id, ...w });
  if (!j.ok("server quote", q)) return j.done();
  const quote = q.body.data, groupId = tag("sit");
  const rv = await post("/api/uat-scheduling", { action: "reserve", assignmentStrategy: "auto", clientRequestId: groupId,
    customerId: CUSTOMER_ID, petIds: [PET_ID], serviceCode: "pet_sitting", cityId: "blr", zoneId: "blr-east", ...w,
    preferredProviderId: sitter.id, ...ADDRESS });
  if (!j.ok("reserve slot", rv)) return j.done();
  const p = rv.body.data.provider;
  const bk = await post("/api/sitting-bookings", { idempotencyKey: `${groupId}-bk`, scheduleGroupId: groupId,
    sittingQuoteId: quote.quoteId, customer: CUSTOMER_BLOCK, pets: PETS, cityId: "blr", zoneId: "blr-east",
    packageCode: quote.packageCode, packageName: quote.packageName, ...w,
    provider: { id: p.id, name: p.name, model: p.model }, totalAmount: quote.totalAmount, amountDueNow: quote.amountDueNow,
    payment: { method: "upi", mode: quote.paymentMode, status: "captured", detail: "vertical journey" }, pricing: { discount: 0 } });
  j.ok("book", bk);
  j.ok("staff ops", await get("/api/sitting-ops", staff));
  j.ok("finance", await get(`/api/sitting-finance?bookingId=${encodeURIComponent(bookingIdOf(bk))}`, staff));
  j.done();
}

async function walking() {
  const j = journey("dog_walking"), w = windowOf(0.5);
  const q = await post("/api/walking-commercial", { packageCode: "walking-30", mode: "once", petCount: 1, walkCount: 1,
    paymentMode: "pay_after_service", ...w });
  if (!j.ok("server quote", q)) return j.done();
  const quote = q.body.data, groupId = tag("walk");
  const rv = await post("/api/uat-scheduling", { action: "reserve", assignmentStrategy: "auto", clientRequestId: groupId,
    customerId: CUSTOMER_ID, petIds: [PET_ID], serviceCode: "dog_walking", cityId: "blr", zoneId: "blr-east", ...w, careMode: "once" });
  if (!j.ok("reserve slot", rv)) return j.done();
  const p = rv.body.data.provider;
  /* No `weekdays`, deliberately: a one-off walk has no weekday pattern and the booking screen sends
     none. That omission used to reach the customer as a 500. */
  const bk = await post("/api/walking-bookings", { idempotencyKey: `${groupId}-bk`, scheduleGroupId: groupId,
    walkingQuoteId: quote.quoteId, walkCount: 1, mode: "once", customer: CUSTOMER_BLOCK, pets: PETS,
    cityId: "blr", zoneId: "blr-east", packageCode: quote.packageCode, packageName: quote.packageName, ...w,
    provider: { id: p.id, name: p.name, model: p.model }, totalAmount: quote.totalAmount, amountDueNow: quote.amountDueNow,
    payment: { method: "cash", mode: quote.paymentMode, status: "created", detail: "vertical journey" }, pricing: { discount: 0 } });
  j.ok("book a one-off walk (no weekday pattern)", bk);
  j.ok("staff ops", await get("/api/walking-ops", staff));
  j.ok("finance", await get(`/api/walking-finance?bookingId=${encodeURIComponent(bookingIdOf(bk))}`, staff));
  j.done();
}

async function boarding() {
  const j = journey("boarding"), w = windowOf(20);
  const catalogue = await get(`/api/boarding-commercial?cityId=blr&zoneId=blr-east&scheduledStart=${encodeURIComponent(w.scheduledStart)}&scheduledEnd=${encodeURIComponent(w.scheduledEnd)}&petCount=1`);
  if (!j.ok("discover hosts and packages", catalogue)) return j.done();
  const host = catalogue.body.data.hosts?.[0];
  const stayHours = (Date.parse(w.scheduledEnd) - Date.parse(w.scheduledStart)) / 3_600_000;
  const pkg = (catalogue.body.data.packages ?? []).find((x) => Number(x.max_hours) >= stayHours);
  if (!host || !pkg) return j.ok("a host and a package that covers the stay", { status: 409, body: { error: "none offered" } }), j.done();
  const q = await post("/api/boarding-commercial", { packageCode: pkg.package_code, petCount: 1, paymentMode: "prepaid",
    cityId: "blr", zoneId: "blr-east", providerId: host.providerId ?? host.id, ...w });
  if (!j.ok("server quote", q)) return j.done();
  const quote = q.body.data, groupId = tag("board");
  /* Boarding requires STAFF-VERIFIED vaccination, not a customer declaration. A pet whose status is
     only "vaccinated" is refused here by design. */
  const rv = await post("/api/uat-scheduling", { action: "reserve", assignmentStrategy: "auto", clientRequestId: groupId,
    customerId: CUSTOMER_ID, petIds: [PET_ID], serviceCode: "boarding", cityId: "blr", zoneId: "blr-east", ...w,
    preferredProviderId: host.providerId ?? host.id });
  if (!j.ok("reserve stay", rv)) return j.done();
  const p = rv.body.data.provider;
  j.ok("book", await post("/api/canonical-bookings", { idempotencyKey: `${groupId}-bk`, scheduleGroupId: groupId,
    customer: CUSTOMER_BLOCK, pets: PETS, cityId: "blr", zoneId: "blr-east", serviceCode: "boarding",
    packageCode: quote.packageCode, packageName: quote.packageName, ...w,
    provider: { id: p.id, name: p.name, model: p.model }, totalAmount: quote.totalAmount, amountDueNow: quote.amountDueNow,
    payment: { method: "upi", mode: quote.paymentMode, status: "captured", detail: "vertical journey" },
    pricing: { discount: 0, boardingQuoteId: quote.quoteId } }));
  j.ok("staff ops", await get("/api/boarding-ops", staff));
  j.done();
}

async function taxi() {
  const j = journey("pet_taxi"), w = windowOf(1);
  /* Pet Taxi Gate 1, like Food Gate 1, is sandbox-deferred only; a prepaid quote is refused by design. */
  j.ok("server quote", await post("/api/taxi-commercial", { routeCode: "taxi-blr-east-short", tripType: "one_way",
    petCount: 1, passengerCount: 1, luggageCount: 0, waitingMinutes: 0, ridePurpose: "vet_visit",
    paymentMode: "sandbox_deferred", originLabel: "Indiranagar", destinationLabel: "Koramangala",
    scheduledStart: w.scheduledStart }));
  j.ok("staff ops", await get("/api/taxi-ops", staff));
  j.done();
}

async function food() {
  const j = journey("food");
  j.ok("server quote", await post("/api/food-commercial", { sku: "food-uat-dog-adult-2kg", quantity: 1,
    zoneId: "blr-east", customerId: CUSTOMER_ID, petIds: [PET_ID], paymentMode: "sandbox_deferred" }));
  j.ok("staff ops", await get("/api/food-ops", staff));
  j.done();
}

async function relocation() {
  const j = journey("relocation");
  const day = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  j.ok("customer enquiry", await post("/api/relocation-enquiry", { customerName: "E2E Customer",
    phonePrimary: "9800000077", email: "e2e.customer@pawspace.test", petType: "dog", relocationKind: "domestic",
    pickupLocation: "Indiranagar, Bengaluru", dropLocation: "Koregaon Park, Pune",
    pickupDate: day, pickupApproxTime: "10:00", expectedTravelDate: day }));
  j.ok("staff queue", await get("/api/relocation", staff));
  j.done();
}

async function funeral() {
  const j = journey("funeral_memorial");
  // Staff-operated: a customer does not self-serve this, they are helped through it.
  j.ok("staff queue", await get("/api/funeral-memorial", staff));
  j.done();
}

async function vet() {
  const j = journey("vet_consult");
  const services = await get("/api/service-availability?cityId=blr&zoneId=blr-east");
  if (!j.ok("service catalogue", services)) return j.done();
  const entry = (services.body.data ?? []).find((s) => s.code === "vet_consult");
  /* Not launched: no provider anywhere offers vet_consult. What must hold is that the picker does not
     OFFER it, so the customer never reaches a dead end dressed up as a busy day. */
  j.ok("not offered until it launches", { status: entry?.enabled ? 409 : 200, body: { error: "vet_consult is published as bookable but no provider can take it" } });
  j.done();
}

for (const run of [grooming, training, sitting, walking, boarding, taxi, food, relocation, funeral, vet]) {
  try { await run(); } catch (error) { results.push({ vertical: run.name, steps: [{ name: "driver error", status: 0, good: false, detail: String(error).slice(0, 200) }] }); }
}

let blocked = 0;
for (const { vertical, steps } of results) {
  const bad = steps.filter((s) => !s.good);
  if (bad.length) blocked += 1;
  console.log(`\n${vertical}: ${bad.length ? "BLOCKED" : "ok"}`);
  for (const s of steps) console.log(`  ${s.good ? "ok  " : "FAIL"} ${s.name} [${s.status}] ${s.detail}`);
}
console.log(`\n${results.length - blocked}/${results.length} verticals complete`);
process.exit(blocked ? 1 : 0);
