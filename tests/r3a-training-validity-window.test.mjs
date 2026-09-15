/**
 * R3-A3 — the 16-session calendar booked past the package's own validity.
 *
 * MEASURED IN A BROWSER: the Pro Training Plan card said "93 days validity"; step 4 said "Validity
 * starts from the first service date"; the calendar under it then listed 16 weekly sessions from
 * Sat 19 Sept to Sat 2 Jan — a 105-day span — and the server reserved all sixteen without complaint
 * (occurrences[15].start = 2027-01-02). Sessions 15 and 16 were paid for and scheduled after the
 * package they belong to had expired.
 *
 * WHICH SIDE WAS WRONG: the validity. The catalogue's own ladder gives 31 days to the 2- and
 * 4-session plans, 62 to the 8s and 93 to the 12s — one, two and three months. The 16-session plan
 * kept 93, the TWELVE-session row's number, where the ladder gives four months. 16 weekly sessions
 * take 105 days; no cadence the app offers could deliver them inside 93.
 *
 * This is the same booking whose 409 was once "fixed" by making two numbers agree while the booking
 * still failed, so the first test below is an OUTCOME test: it reserves the plan through the REAL
 * route against a real database and measures the LAST ROW WRITTEN against the validity the REAL
 * catalogue route serves to the screen. It fails if either the booking breaks or the calendar
 * overruns.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { seedOwnedPet } from "./helpers/saved-pet-fixture.mjs";

installWorkersHooks("__R3A_TRAINING_VALIDITY_DB__", "__R3A_TRAINING_VALIDITY_ENV__");
// seedUatRoster publishes the synthetic roster the reserve needs; it is a declared capability, not a default.
globalThis.__R3A_TRAINING_VALIDITY_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_SCHEDULING_ENV: "uat" };

const commercial = await import("../lib/training-commercial-governance.ts");
const guards = await import("../lib/training-booking-guards.ts");
const catalogueRoute = await import("../app/api/training-commercial/route.ts");

const DAY = 86_400_000;
const CUSTOMER = "CUST-R3A-VALIDITY";
const PET = "PET-R3A-VALIDITY";
const TRAINER = "train_kiran";
const PRO = commercial.TRAINING_PACKAGE_DEFAULTS.find((plan) => plan.code === "training-16-pro");

async function world() {
  const { sqlite, db } = freshCountingD1();
  globalThis.__R3A_TRAINING_VALIDITY_DB__ = db;
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  const { seedProviderCapacityDefaults } = await import("../lib/provider-capacity-governance.ts");
  await ensureSecurityTables(db);
  await seedProviderCapacityDefaults(db);
  await seedOwnedPet(db, CUSTOMER, PET, "Bruno");
  return { sqlite, db };
}

async function customerCookie(db) {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "customer_otp", principalType: "identity_subject", principalKey: `customer:${CUSTOMER}`,
    subjectType: "customer", subjectId: CUSTOMER, verificationState: "verified",
    actorId: "r3a-validity", reason: "R3-A3 training validity window regression",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: String(binding.identity_source),
    principalType: String(binding.principal_type), principalKey: String(binding.principal_key),
    subjectType: "customer", subjectId: CUSTOMER,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

async function reserve(cookie, body) {
  const route = await import("../app/api/uat-scheduling/route.ts");
  const response = await route.POST(new Request("https://uat.pawspace.in/api/uat-scheduling", {
    method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body),
  }));
  let parsed = null;
  try { parsed = await response.clone().json(); } catch { /* non-JSON */ }
  return { status: response.status, body: parsed };
}

/** 10:00–11:00 IST, inside the roster window, far enough out to clear the lead time. */
function futureWindow(offsetDays = 30) {
  const day = new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
  return { scheduledStart: `${day}T04:30:00.000Z`, scheduledEnd: `${day}T05:30:00.000Z` };
}

let seq = 0;
const reserveBody = (overrides = {}) => ({
  clientRequestId: `r3a-validity-${++seq}`, customerId: CUSTOMER, petIds: [PET],
  serviceCode: "dog_training", cityId: "blr", zoneId: "blr-east", cadenceDays: 7,
  preferredProviderId: TRAINER, ...futureWindow(), ...overrides,
});

const rows = (sqlite, groupId) => sqlite
  .prepare("SELECT occurrence_number,scheduled_start FROM scheduling_reservations WHERE group_id=? ORDER BY occurrence_number")
  .all(groupId);

// ---------------------------------------------------------------------------------------------
test("OUTCOME: the 16-session plan books, and its last reserved session is inside the validity the screen was shown", async () => {
  const { sqlite, db } = await world();
  const cookie = await customerCookie(db);

  // The number the customer reads on the plan card, taken from the REAL catalogue route.
  const catalogue = await (await catalogueRoute.GET()).json();
  const shown = catalogue.data.packages.find((item) => item.package_code === "training-16-pro");
  assert.ok(shown, "the Pro Training Plan must still be on sale");
  assert.equal(Number(shown.sessions), 16);

  // The booking the customer actually makes: sixteen sessions, weekly.
  const body = reserveBody({ occurrences: 16 });
  const result = await reserve(cookie, body);
  assert.equal(result.status, 200, `the 16-session plan must still reserve end to end: ${JSON.stringify(result.body).slice(0, 500)}`);

  const reserved = rows(sqlite, body.clientRequestId);
  assert.equal(reserved.length, 16, "governTrainingBooking demands exactly 16 reservations");
  const spanDays = (new Date(reserved.at(-1).scheduled_start).getTime() - new Date(reserved[0].scheduled_start).getTime()) / DAY;
  assert.equal(spanDays, 105, "sixteen weekly sessions genuinely take 105 days — that was never the wrong number");
  assert.ok(
    spanDays <= Number(shown.validity_days),
    `the calendar runs ${spanDays} days from the first service date while the card promises ` +
    `${shown.validity_days} days of validity: sessions ${Math.ceil((spanDays - Number(shown.validity_days)) / 7)} ` +
    "from the end are paid for and scheduled into expiry",
  );

  // Every single reserved session, not just the last, has to sit inside the window.
  const validUntil = new Date(reserved[0].scheduled_start).getTime() + Number(shown.validity_days) * DAY;
  for (const row of reserved) {
    assert.ok(new Date(row.scheduled_start).getTime() <= validUntil,
      `session ${row.occurrence_number} on ${row.scheduled_start} falls outside the package validity`);
  }
});

test("every plan the catalogue sells can be delivered inside its own validity", async () => {
  const { db } = await world();
  await commercial.ensureTrainingCommercialTables(db);
  const served = await commercial.listTrainingPackages(db);
  assert.ok(served.length >= 8, "the seeded Training catalogue must still be there");
  for (const row of served) {
    const sessions = Number(row.sessions), validityDays = Number(row.validity_days);
    assert.ok(
      guards.trainingPackageValidityCoversSessions({ sessions, validityDays }),
      `${row.package_code} sells ${sessions} sessions but only ${validityDays} days of validity; ` +
      `at the slowest repeat schedule the app offers those sessions need ${guards.trainingSlowestScheduleSpanDays(sessions)} days`,
    );
  }
});

test("the catalogue rule refuses a package whose validity cannot hold its own sessions", () => {
  // The exact row that shipped: 16 sessions, 93 days.
  assert.throws(
    () => commercial.assertTrainingPackageValidity({ code: "training-16-pro", sessions: 16, validityDays: 93 }),
    (error) => error instanceof Response && error.status === 409,
  );
  // And it is not a blanket refusal: the corrected row, and every smaller plan, pass.
  commercial.assertTrainingPackageValidity({ code: "training-16-pro", sessions: 16, validityDays: 124 });
  commercial.assertTrainingPackageValidity({ code: "training-12-leash", sessions: 12, validityDays: 93 });
  commercial.assertTrainingPackageValidity({ code: "trainer-meet-greet", sessions: 1, validityDays: 7 });
});

test("a database already seeded with the impossible validity is repaired, not left selling it", async () => {
  const { sqlite, db } = await world();
  await commercial.ensureTrainingCommercialTables(db);
  sqlite.prepare("UPDATE training_commercial_packages SET validity_days=93 WHERE package_code='training-16-pro'").run();
  assert.equal(sqlite.prepare("SELECT validity_days v FROM training_commercial_packages WHERE package_code='training-16-pro'").get().v, 93, "fixture did not take");

  await commercial.ensureTrainingCommercialTables(db);

  const repaired = Number(sqlite.prepare("SELECT validity_days v FROM training_commercial_packages WHERE package_code='training-16-pro'").get().v);
  assert.equal(repaired, PRO.validityDays);
  assert.ok(guards.trainingPackageValidityCoversSessions({ sessions: 16, validityDays: repaired }));
});

test("a validity Pricing Control has deliberately set is never overwritten by the seed", async () => {
  const { sqlite, db } = await world();
  await commercial.ensureTrainingCommercialTables(db);
  sqlite.prepare("UPDATE training_commercial_packages SET validity_days=150,updated_by='pricing_control',version=2 WHERE package_code='training-16-pro'").run();
  await commercial.ensureTrainingCommercialTables(db);
  assert.equal(Number(sqlite.prepare("SELECT validity_days v FROM training_commercial_packages WHERE package_code='training-16-pro'").get().v), 150);
});

test("the schedule guard measures the calendar the customer is shown, cadence by cadence", () => {
  // Every Saturday: session 16 is 15 weeks out. Tue & Sat: the same 16 sessions fit in under 8 weeks.
  const weekly = guards.trainingScheduleWithinValidity({ weekdays: [6], sessions: 16, startWeekday: 6, validityDays: 93 });
  assert.equal(weekly.spanDays, 105);
  assert.equal(weekly.ok, false);
  assert.equal(weekly.overrunDays, 12);
  assert.equal(guards.trainingScheduleWithinValidity({ weekdays: [6], sessions: 16, startWeekday: 6, validityDays: PRO.validityDays }).ok, true);
  const twiceWeekly = guards.trainingScheduleWithinValidity({ weekdays: [2, 6], sessions: 16, startWeekday: 6, validityDays: 93 });
  assert.ok(twiceWeekly.spanDays < 93 && twiceWeekly.ok, "a twice-weekly 16-session plan always fitted; the weekly one never did");
});
