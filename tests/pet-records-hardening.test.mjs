import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";
import { createD1 } from "./helpers/d1.mjs";

// ---------------------------------------------------------------------------
// Task 20 audit — pet records (passport, vaccination, birthday, emergency).
// Real execution over real SQLite. The properties that matter: a pet record
// only ever belongs to its owner, the public passport share leaks no owner PII,
// the daily sweeps are idempotent (a pet cannot collect two birthday rewards or
// two identical reminders), and a reward cannot be spent twice.
// ---------------------------------------------------------------------------
const WORKERS_SHIM = `export const env = new Proxy({}, { get: (_, key) => globalThis.__PAWSPACE_TEST_ENV?.[key] });`;
const workersUrl = `data:text/javascript,${encodeURIComponent(WORKERS_SHIM)}`;

if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `const workersUrl=${JSON.stringify(workersUrl)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// batch() is one transaction in D1: see tests/helpers/d1.mjs. The loop this replaced committed
// each statement as it went, so any atomicity claim below was measured against the wrong machine.
const makeD1 = (sqlite, options) => createD1(sqlite, options);

const NOW = 1770000000000;
const DAY = 86400000;

function fresh() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db };
  sqlite.exec("CREATE TABLE canonical_customers (id TEXT PRIMARY KEY,city_id TEXT,name TEXT NOT NULL,primary_phone TEXT NOT NULL,email TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,name TEXT NOT NULL,species TEXT,breed TEXT,vaccination_status TEXT,source_pet_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,service_code TEXT NOT NULL,package_name TEXT,status TEXT NOT NULL,scheduled_start TEXT,scheduled_end TEXT,total_amount REAL,currency TEXT DEFAULT 'INR',created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE provider_capacity_profiles (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,provider_model TEXT NOT NULL,services_json TEXT NOT NULL,zones_json TEXT NOT NULL,live INTEGER NOT NULL DEFAULT 1,rating REAL DEFAULT 0,quality_score REAL DEFAULT 0,status TEXT NOT NULL DEFAULT 'active',effective_from TEXT,updated_by TEXT,updated_at INTEGER)");
  return { sqlite, db };
}

function seedOwner(sqlite, customerId, petId, petName = "Bruno") {
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,email,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(customerId, "blr", `Owner ${customerId}`, "9876500099", `${customerId}@example.test`, NOW, NOW);
  sqlite.prepare("INSERT INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,source_pet_id,created_at,updated_at) VALUES (?,?,?,?,?,?,NULL,?,?)")
    .run(petId, customerId, petName, "dog", "Labrador", "not_provided", NOW, NOW);
}

// ---------------------------------------------------------------------------
// 1. Vaccination records: ownership, validation, supersede, idempotent sweep.
// ---------------------------------------------------------------------------
test("vaccination: ownership enforced and dates validated against reality", async () => {
  const { sqlite, db } = fresh();
  const vax = await import("../lib/pet-vaccination-governance.ts");
  seedOwner(sqlite, "CUS-1", "PET-1");
  seedOwner(sqlite, "CUS-2", "PET-2", "Kaju");

  await assert.rejects(
    () => vax.recordVaccination(db, { petId: "PET-2", customerId: "CUS-1", vaccineType: "Rabies", administeredOn: "2026-07-01", actorId: "CUS-1" }),
    /only record vaccinations for your own pet/,
  );
  await assert.rejects(
    () => vax.recordVaccination(db, { petId: "PET-1", customerId: "CUS-1", vaccineType: "Rabies", administeredOn: "01-07-2026", actorId: "CUS-1" }),
    /valid YYYY-MM-DD date/,
  );
  const future = new Date(Date.now() + 30 * DAY).toISOString().slice(0, 10);
  await assert.rejects(
    () => vax.recordVaccination(db, { petId: "PET-1", customerId: "CUS-1", vaccineType: "Rabies", administeredOn: future, actorId: "CUS-1" }),
    /cannot be in the future/,
  );
  await assert.rejects(
    () => vax.recordVaccination(db, { petId: "PET-1", customerId: "CUS-1", vaccineType: "Rabies", administeredOn: "2026-07-01", nextDueOn: "2026-06-01", actorId: "CUS-1" }),
    /after the administered date/,
  );
  await assert.rejects(
    () => vax.recordVaccination(db, { petId: "PET-MISSING", customerId: "CUS-1", vaccineType: "Rabies", administeredOn: "2026-07-01", actorId: "CUS-1" }),
    /Pet not found/,
  );

  const first = await vax.recordVaccination(db, { petId: "PET-1", customerId: "CUS-1", vaccineType: "Rabies", administeredOn: "2025-07-01", nextDueOn: "2026-07-01", administeredBy: "Dr Rao", actorId: "CUS-1" });
  assert.equal(first.nextDueOn, "2026-07-01");
  assert.equal(sqlite.prepare("SELECT vaccination_status FROM canonical_pets WHERE id='PET-1'").get().vaccination_status, "recorded", "the canonical pet flag stays in sync");

  // A newer record of the SAME vaccine supersedes the old one: exactly one active per vaccine.
  await vax.recordVaccination(db, { petId: "PET-1", customerId: "CUS-1", vaccineType: "Rabies", administeredOn: "2026-07-02", nextDueOn: "2027-07-02", actorId: "CUS-1" });
  const active = sqlite.prepare("SELECT administered_on FROM pet_vaccinations WHERE pet_id='PET-1' AND vaccine_type='Rabies' AND status='active'").all();
  assert.equal(active.length, 1);
  assert.equal(active[0].administered_on, "2026-07-02");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM pet_vaccinations WHERE pet_id='PET-1'").get().c, 2, "history is kept, not overwritten");

  // A different vaccine coexists.
  await vax.recordVaccination(db, { petId: "PET-1", customerId: "CUS-1", vaccineType: "DHPP", administeredOn: "2026-07-02", nextDueOn: "2027-07-02", actorId: "CUS-1" });
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM pet_vaccinations WHERE pet_id='PET-1' AND status='active'").get().c, 2);

  const list = await vax.listPetVaccinations(db, { customerId: "CUS-1", petId: "PET-1" });
  assert.equal(list.length, 3);
  const otherOwner = await vax.listPetVaccinations(db, { customerId: "CUS-2" });
  assert.equal(otherOwner.length, 0, "another owner sees none of this pet's records");
});

test("vaccination sweep: one reminder per stage, escalating upcoming -> due -> overdue", async () => {
  const { sqlite, db } = fresh();
  const vax = await import("../lib/pet-vaccination-governance.ts");
  seedOwner(sqlite, "CUS-S", "PET-S");
  await vax.recordVaccination(db, { petId: "PET-S", customerId: "CUS-S", vaccineType: "Rabies", administeredOn: "2025-08-10", nextDueOn: "2026-08-10", actorId: "CUS-S" });

  // Outside the 14-day window: nothing raised.
  const early = await vax.runVaccinationDueSweep(db, { today: "2026-07-01" });
  assert.equal(early.remindersRaised, 0);

  // Inside the window: one 'upcoming' reminder, and re-running does not duplicate it.
  const upcoming = await vax.runVaccinationDueSweep(db, { today: "2026-08-01" });
  assert.equal(upcoming.remindersRaised, 1);
  assert.equal(upcoming.reminders[0].stage, "upcoming");
  assert.equal((await vax.runVaccinationDueSweep(db, { today: "2026-08-02" })).remindersRaised, 0, "a second sweep does not re-notify the same stage");

  const due = await vax.runVaccinationDueSweep(db, { today: "2026-08-10" });
  assert.equal(due.reminders[0].stage, "due");
  const overdue = await vax.runVaccinationDueSweep(db, { today: "2026-08-15" });
  assert.equal(overdue.reminders[0].stage, "overdue");
  assert.equal((await vax.runVaccinationDueSweep(db, { today: "2026-08-20" })).remindersRaised, 0, "overdue is reported once, not every five minutes");
  const stages = sqlite.prepare("SELECT stage FROM pet_vaccination_reminders WHERE pet_id='PET-S' ORDER BY created_at").all().map((row) => row.stage);
  assert.deepEqual([...new Set(stages)].sort(), ["due", "overdue", "upcoming"]);

  // A vaccination with no next-due date is never chased.
  seedOwner(sqlite, "CUS-N", "PET-N", "NoDue");
  await vax.recordVaccination(db, { petId: "PET-N", customerId: "CUS-N", vaccineType: "Rabies", administeredOn: "2026-01-01", actorId: "CUS-N" });
  assert.equal((await vax.runVaccinationDueSweep(db, { today: "2026-08-20" })).remindersRaised, 0);
});

// ---------------------------------------------------------------------------
// 2. Birthday: ownership, one reward per pet per year, single-use redemption.
// ---------------------------------------------------------------------------
test("birthday: ownership and future dates rejected, DOB upserts in place", async () => {
  const { sqlite, db } = fresh();
  const birthday = await import("../lib/pet-birthday-governance.ts");
  seedOwner(sqlite, "CUS-B1", "PET-B1");
  seedOwner(sqlite, "CUS-B2", "PET-B2", "Simba");

  await assert.rejects(() => birthday.savePetBirthday(db, { petId: "PET-B2", customerId: "CUS-B1", dateOfBirth: "2022-08-15", actorId: "CUS-B1" }), /your own pet/);
  const future = new Date(Date.now() + 5 * DAY).toISOString().slice(0, 10);
  await assert.rejects(() => birthday.savePetBirthday(db, { petId: "PET-B1", customerId: "CUS-B1", dateOfBirth: future, actorId: "CUS-B1" }), /cannot be in the future/);

  await birthday.savePetBirthday(db, { petId: "PET-B1", customerId: "CUS-B1", dateOfBirth: "2022-08-15", actorId: "CUS-B1" });
  await birthday.savePetBirthday(db, { petId: "PET-B1", customerId: "CUS-B1", dateOfBirth: "2022-08-16", actorId: "CUS-B1" });
  const rows = sqlite.prepare("SELECT date_of_birth FROM pet_birthdays WHERE pet_id='PET-B1'").all();
  assert.equal(rows.length, 1, "one birthday row per pet");
  assert.equal(rows[0].date_of_birth, "2022-08-16");
});

test("birthday sweep: exactly one reward per pet per year, and the reward is single-use", async () => {
  const { sqlite, db } = fresh();
  const birthday = await import("../lib/pet-birthday-governance.ts");
  seedOwner(sqlite, "CUS-BD", "PET-BD");
  seedOwner(sqlite, "CUS-OTHER", "PET-OTHER", "Rocky");
  await birthday.savePetBirthday(db, { petId: "PET-BD", customerId: "CUS-BD", dateOfBirth: "2022-08-15", actorId: "CUS-BD" });
  await birthday.savePetBirthday(db, { petId: "PET-OTHER", customerId: "CUS-OTHER", dateOfBirth: "2021-03-02", actorId: "CUS-OTHER" });

  assert.equal((await birthday.runPetBirthdaySweep(db, { today: "2026-08-14" })).rewardsIssued, 0, "the day before is not the birthday");
  const issued = await birthday.runPetBirthdaySweep(db, { today: "2026-08-15" });
  assert.equal(issued.rewardsIssued, 1);
  assert.equal(issued.rewards[0].petId, "PET-BD");
  assert.equal(issued.rewards[0].discount, birthday.BIRTHDAY_GROOMING_DISCOUNT);
  // The scheduler runs every five minutes: re-running the same day must not issue again.
  assert.equal((await birthday.runPetBirthdaySweep(db, { today: "2026-08-15" })).rewardsIssued, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM pet_birthday_rewards WHERE pet_id='PET-BD'").get().c, 1);
  // Next year is a new reward year.
  assert.equal((await birthday.runPetBirthdaySweep(db, { today: "2027-08-15" })).rewardsIssued, 1);

  const code = issued.rewards[0].code;
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,package_name,status,scheduled_start,scheduled_end,total_amount,currency,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("BK-GROOM", "CUS-BD", "grooming", "Dog bath", "confirmed", "2026-08-20T05:00:00.000Z", "2026-08-20T06:00:00.000Z", 1349, "INR", NOW, NOW);
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,package_name,status,scheduled_start,scheduled_end,total_amount,currency,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("BK-BOARD", "CUS-BD", "boarding", "Standard stay", "confirmed", "2026-08-25T05:00:00.000Z", "2026-08-27T06:00:00.000Z", 4500, "INR", NOW, NOW);
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,package_name,status,scheduled_start,scheduled_end,total_amount,currency,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("BK-STRANGER", "CUS-OTHER", "grooming", "Dog bath", "confirmed", "2026-08-20T05:00:00.000Z", "2026-08-20T06:00:00.000Z", 1349, "INR", NOW, NOW);

  await assert.rejects(() => birthday.redeemBirthdayReward(db, { code, customerId: "CUS-OTHER", bookingId: "BK-STRANGER", actorId: "CUS-OTHER" }), /belongs to another account/);
  await assert.rejects(() => birthday.redeemBirthdayReward(db, { code, customerId: "CUS-BD", bookingId: "BK-STRANGER", actorId: "CUS-BD" }), /your own booking/);
  await assert.rejects(() => birthday.redeemBirthdayReward(db, { code, customerId: "CUS-BD", bookingId: "BK-BOARD", actorId: "CUS-BD" }), /doorstep grooming only/);

  const redeemed = await birthday.redeemBirthdayReward(db, { code, customerId: "CUS-BD", bookingId: "BK-GROOM", actorId: "CUS-BD" });
  assert.equal(redeemed.discountApplied, 500);
  assert.equal(redeemed.duplicatePrevented, false);
  await assert.rejects(() => birthday.redeemBirthdayReward(db, { code, customerId: "CUS-BD", bookingId: "BK-GROOM", actorId: "CUS-BD" }), /already been used/);
  const active = await birthday.listBirthdayRewards(db, "CUS-BD");
  assert.ok(!active.some((row) => row.code === code), "a spent reward is no longer offered");
});

test("birthday reward cannot be double-spent by two concurrent redeems", async () => {
  const { sqlite, db } = fresh();
  const birthday = await import("../lib/pet-birthday-governance.ts");
  seedOwner(sqlite, "CUS-RACE", "PET-RACE");
  await birthday.savePetBirthday(db, { petId: "PET-RACE", customerId: "CUS-RACE", dateOfBirth: "2020-08-15", actorId: "CUS-RACE" });
  const issued = await birthday.runPetBirthdaySweep(db, { today: "2026-08-15" });
  const code = issued.rewards[0].code;
  for (const id of ["BK-R1", "BK-R2"]) {
    sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,package_name,status,scheduled_start,scheduled_end,total_amount,currency,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, "CUS-RACE", "grooming", "Dog bath", "confirmed", "2026-08-20T05:00:00.000Z", "2026-08-20T06:00:00.000Z", 1349, "INR", NOW, NOW);
  }
  const results = await Promise.allSettled([
    birthday.redeemBirthdayReward(db, { code, customerId: "CUS-RACE", bookingId: "BK-R1", actorId: "CUS-RACE" }),
    birthday.redeemBirthdayReward(db, { code, customerId: "CUS-RACE", bookingId: "BK-R2", actorId: "CUS-RACE" }),
  ]);
  const applied = results.filter((r) => r.status === "fulfilled" && r.value.duplicatePrevented === false);
  assert.equal(applied.length, 1, "exactly one booking may claim the Rs.500");
  const row = sqlite.prepare("SELECT status,redeemed_booking_id FROM pet_birthday_rewards WHERE code=?").get(code);
  assert.equal(row.status, "redeemed");
  assert.ok(["BK-R1", "BK-R2"].includes(row.redeemed_booking_id));
});

test("birthday reward expires and an expired code cannot be redeemed", async () => {
  const { sqlite, db } = fresh();
  const birthday = await import("../lib/pet-birthday-governance.ts");
  seedOwner(sqlite, "CUS-EXP", "PET-EXP");
  await birthday.savePetBirthday(db, { petId: "PET-EXP", customerId: "CUS-EXP", dateOfBirth: "2020-08-15", actorId: "CUS-EXP" });
  const issued = await birthday.runPetBirthdaySweep(db, { today: "2026-08-15" });
  const code = issued.rewards[0].code;
  sqlite.prepare("UPDATE pet_birthday_rewards SET expires_at=? WHERE code=?").run(Date.now() - 1000, code);
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,package_name,status,scheduled_start,scheduled_end,total_amount,currency,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("BK-EXP", "CUS-EXP", "grooming", "Dog bath", "confirmed", "2026-08-20T05:00:00.000Z", "2026-08-20T06:00:00.000Z", 1349, "INR", NOW, NOW);
  await assert.rejects(() => birthday.redeemBirthdayReward(db, { code, customerId: "CUS-EXP", bookingId: "BK-EXP", actorId: "CUS-EXP" }), /expired/);
  assert.equal((await birthday.listBirthdayRewards(db, "CUS-EXP")).length, 0, "expired rewards are not advertised as available");
});

// ---------------------------------------------------------------------------
// 3. Passport: owner view is owner-only; the shared card carries no owner PII.
// ---------------------------------------------------------------------------
test("passport: owner-only view, share link is revocable, public card has no owner PII", async () => {
  const { sqlite, db } = fresh();
  const passport = await import("../lib/pet-passport-governance.ts");
  const vax = await import("../lib/pet-vaccination-governance.ts");
  const birthday = await import("../lib/pet-birthday-governance.ts");
  seedOwner(sqlite, "CUS-P", "PET-P", "Bruno");
  seedOwner(sqlite, "CUS-Q", "PET-Q", "Coco");
  await birthday.savePetBirthday(db, { petId: "PET-P", customerId: "CUS-P", dateOfBirth: "2022-08-15", actorId: "CUS-P" });
  await vax.recordVaccination(db, { petId: "PET-P", customerId: "CUS-P", vaccineType: "Rabies", administeredOn: "2026-01-10", nextDueOn: "2099-01-10", actorId: "CUS-P" });

  await assert.rejects(() => passport.getPetPassport(db, { customerId: "CUS-Q", petId: "PET-P" }), /Pet not found/, "another customer cannot read this pet's passport");
  const owner = await passport.getPetPassport(db, { customerId: "CUS-P", petId: "PET-P" });
  assert.equal(owner.name, "Bruno");
  assert.equal(owner.dateOfBirth, "2022-08-15");
  assert.equal(owner.vaccinationUpToDate, true);
  assert.ok(owner.badges.includes("Fully Vaccinated"));

  await assert.rejects(() => passport.createPetPassportShare(db, { customerId: "CUS-Q", petId: "PET-P", actorId: "CUS-Q" }), /your own pet/);
  const share = await passport.createPetPassportShare(db, { customerId: "CUS-P", petId: "PET-P", actorId: "CUS-P" });
  assert.ok(share.token.length >= 32, "the share token is unguessable, not a pet id");
  const again = await passport.createPetPassportShare(db, { customerId: "CUS-P", petId: "PET-P", actorId: "CUS-P" });
  assert.equal(again.token, share.token, "re-sharing reuses the live link instead of leaking a second one");

  const publicCard = await passport.getSharedPetPassport(db, share.token);
  const serialized = JSON.stringify(publicCard);
  assert.equal(publicCard.name, "Bruno");
  assert.ok(!("customerId" in publicCard) && !("pawPoints" in publicCard), "no owner identity or exact points on a public card");
  assert.ok(!serialized.includes("9876500099"), "no owner phone number");
  assert.ok(!serialized.includes("@example.test"), "no owner email");
  assert.ok(!serialized.includes("CUS-P"), "no customer id");
  assert.ok(!serialized.includes("2022-08-15"), "the exact date of birth is not published, only a friendly age");

  await assert.rejects(() => passport.revokePetPassportShare(db, { customerId: "CUS-Q", token: share.token }), /your own share link/);
  await passport.revokePetPassportShare(db, { customerId: "CUS-P", token: share.token });
  assert.equal(await passport.getSharedPetPassport(db, share.token), null, "a revoked link stops working immediately");
  assert.equal(await passport.getSharedPetPassport(db, "not-a-real-token"), null);
});

test("passport: an overdue vaccine is reported honestly, not badged as fully vaccinated", async () => {
  const { sqlite, db } = fresh();
  const passport = await import("../lib/pet-passport-governance.ts");
  const vax = await import("../lib/pet-vaccination-governance.ts");
  seedOwner(sqlite, "CUS-OD", "PET-OD");
  await vax.recordVaccination(db, { petId: "PET-OD", customerId: "CUS-OD", vaccineType: "Rabies", administeredOn: "2024-01-10", nextDueOn: "2025-01-10", actorId: "CUS-OD" });
  const owner = await passport.getPetPassport(db, { customerId: "CUS-OD", petId: "PET-OD" });
  assert.equal(owner.vaccinations[0].status, "overdue");
  assert.equal(owner.vaccinationUpToDate, false);
  assert.ok(!owner.badges.includes("Fully Vaccinated"));

  // A pet with no vaccination record at all is not "up to date" either.
  seedOwner(sqlite, "CUS-NONE", "PET-NONE", "Blank");
  const blank = await passport.getPetPassport(db, { customerId: "CUS-NONE", petId: "PET-NONE" });
  assert.equal(blank.vaccinationUpToDate, false);
  assert.equal(blank.vaccinations.length, 0);
});

// ---------------------------------------------------------------------------
// 4. Emergency: real dispatch, ownership on pet AND booking, single resolve.
// ---------------------------------------------------------------------------
test("emergency: dispatches a real live partner in the zone and opens a high-severity case", async () => {
  const { sqlite, db } = fresh();
  const emergency = await import("../lib/pet-emergency-governance.ts");
  seedOwner(sqlite, "CUS-E", "PET-E");
  const provider = (id, name, live, status, zones, quality) =>
    sqlite.prepare("INSERT INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,status,effective_from,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, "blr", name, "field_partner", "[]", JSON.stringify(zones), live, 4, quality, status, "2026-01-01", "test", NOW);
  provider("PROV-OFFLINE", "Offline Partner", 0, "active", ["blr-east"], 9.9);
  provider("PROV-SUSPENDED", "Suspended Partner", 1, "suspended", ["blr-east"], 9.8);
  provider("PROV-WRONGZONE", "Wrong Zone Partner", 1, "active", ["blr-west"], 9.7);
  provider("PROV-BEST", "Best Available", 1, "active", ["blr-east"], 8.0);

  const raised = await emergency.raiseEmergencyRequest(db, { customerId: "CUS-E", petId: "PET-E", emergencyType: "injury", description: "Bruno is limping badly", cityId: "blr", zoneId: "blr-east", actorId: "CUS-E" });
  assert.equal(raised.status, "partner_dispatched");
  assert.equal(raised.dispatchedProvider.id, "PROV-BEST", "offline, suspended and out-of-zone partners are never dispatched");
  assert.equal(raised.escalatedToOps, false);
  assert.ok(raised.caseId, "a real case is opened for Ops");
  const openedCase = sqlite.prepare("SELECT case_type,severity,owner_team FROM unified_cases WHERE id=?").get(raised.caseId);
  assert.equal(openedCase.case_type, "safety_incident");
  assert.equal(openedCase.severity, "high");
  assert.equal(openedCase.owner_team, "operations");
});

test("emergency: no available partner escalates to Ops instead of failing silently", async () => {
  const { sqlite, db } = fresh();
  const emergency = await import("../lib/pet-emergency-governance.ts");
  seedOwner(sqlite, "CUS-E2", "PET-E2");
  const raised = await emergency.raiseEmergencyRequest(db, { customerId: "CUS-E2", petId: "PET-E2", emergencyType: "poisoning", description: "Ate something toxic", cityId: "blr", zoneId: "blr-north", actorId: "CUS-E2" });
  assert.equal(raised.status, "raised");
  assert.equal(raised.dispatchedProvider, null);
  assert.equal(raised.escalatedToOps, true);
  assert.ok(raised.caseId, "Ops still gets a case even with nobody to dispatch");
});

test("emergency: ownership enforced on the pet AND the referenced booking, resolve happens once", async () => {
  const { sqlite, db } = fresh();
  const emergency = await import("../lib/pet-emergency-governance.ts");
  seedOwner(sqlite, "CUS-A", "PET-A");
  seedOwner(sqlite, "CUS-B", "PET-B", "Milo");
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,package_name,status,scheduled_start,scheduled_end,total_amount,currency,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("BK-B", "CUS-B", "boarding", "Standard stay", "confirmed", "2026-08-20T05:00:00.000Z", "2026-08-22T06:00:00.000Z", 4500, "INR", NOW, NOW);

  await assert.rejects(
    () => emergency.raiseEmergencyRequest(db, { customerId: "CUS-A", petId: "PET-B", emergencyType: "injury", description: "Someone else's pet", cityId: "blr", zoneId: "blr-east", actorId: "CUS-A" }),
    /your own pet/,
  );
  await assert.rejects(
    () => emergency.raiseEmergencyRequest(db, { customerId: "CUS-A", petId: "PET-A", bookingId: "BK-B", emergencyType: "injury", description: "Attaching another customer's booking", cityId: "blr", zoneId: "blr-east", actorId: "CUS-A" }),
    /your own booking/,
  );
  await assert.rejects(
    () => emergency.raiseEmergencyRequest(db, { customerId: "CUS-A", petId: "PET-A", emergencyType: "injury", description: "ok", cityId: "blr", zoneId: "blr-east", actorId: "CUS-A" }),
    /describe the emergency/,
  );

  const raised = await emergency.raiseEmergencyRequest(db, { customerId: "CUS-A", petId: "PET-A", emergencyType: "injury", description: "Cut on the front paw", cityId: "blr", zoneId: "blr-east", actorId: "CUS-A" });
  await assert.rejects(() => emergency.resolveEmergencyRequest(db, { requestId: raised.id, actorId: "ops", resolutionNote: "ok" }), /resolution note is required/);
  const results = await Promise.allSettled([
    emergency.resolveEmergencyRequest(db, { requestId: raised.id, actorId: "ops.one@pawspace.in", resolutionNote: "First responder treated the paw on site" }),
    emergency.resolveEmergencyRequest(db, { requestId: raised.id, actorId: "ops.two@pawspace.in", resolutionNote: "Second note that must not overwrite the first" }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "only one Ops user resolves the emergency");
  const row = sqlite.prepare("SELECT status,resolution_note FROM pet_emergency_requests WHERE id=?").get(raised.id);
  assert.equal(row.status, "resolved");
  assert.ok(row.resolution_note.length > 5);

  // A customer only sees their own emergencies.
  assert.equal((await emergency.listEmergencyRequests(db, { customerId: "CUS-A" })).length, 1);
  assert.equal((await emergency.listEmergencyRequests(db, { customerId: "CUS-B" })).length, 0);
});

// ---------------------------------------------------------------------------
// 5. Cold DB + scheduler wiring: sweeps are safe before any pet exists.
// ---------------------------------------------------------------------------
test("pet sweeps are cold-DB safe and wired into the scheduled worker", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db };
  const birthday = await import("../lib/pet-birthday-governance.ts");
  const vax = await import("../lib/pet-vaccination-governance.ts");
  // No canonical_pets table at all - the scheduled worker must not crash the whole run.
  assert.equal((await birthday.runPetBirthdaySweep(db, { today: "2026-08-15" })).rewardsIssued, 0);
  assert.equal((await vax.runVaccinationDueSweep(db, { today: "2026-08-15" })).remindersRaised, 0);

  const scheduler = read("lib/background-scheduler.ts");
  assert.ok(/runPetBirthdaySweep\(db/.test(scheduler), "birthday sweep runs on the scheduler");
  assert.ok(/runVaccinationDueSweep\(db/.test(scheduler), "vaccination sweep runs on the scheduler");
  assert.ok(/petBirthdayRewards/.test(scheduler) && /vaccinationReminders/.test(scheduler), "both sweeps are named in the scheduler result");
});

test("pet record modules do not fabricate values or use banned DB access", () => {
  for (const path of [
    "lib/pet-birthday-governance.ts", "lib/pet-vaccination-governance.ts",
    "lib/pet-passport-governance.ts", "lib/pet-emergency-governance.ts",
  ]) {
    const source = read(path);
    assert.ok(!/Math\.random/.test(source), `${path} must not fabricate values with Math.random`);
    assert.ok(!/globalThis\.__D1__/.test(source), `${path} must not use the banned globalThis D1 pattern`);
  }
});
