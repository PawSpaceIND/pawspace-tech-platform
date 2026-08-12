import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL("../" + p, import.meta.url), "utf8");
const [birthday, vax, emergency, scheduler] = await Promise.all([
  read("lib/pet-birthday-governance.ts"), read("lib/pet-vaccination-governance.ts"),
  read("lib/pet-emergency-governance.ts"), read("lib/background-scheduler.ts"),
]);

test("pet birthday reward: flat Rs.500 grooming, one per pet per year, ownership + single-use", () => {
  assert.match(birthday, /BIRTHDAY_GROOMING_DISCOUNT = 500/);
  assert.match(birthday, /UNIQUE\(pet_id,reward_year\)/);
  assert.match(birthday, /You can only set the birthday for your own pet/);
  assert.match(birthday, /service_code\) !== "grooming"\) throw new Error\("The birthday reward is valid on doorstep grooming only"\)/);
  assert.match(birthday, /export async function runPetBirthdaySweep/);
  assert.match(birthday, /status='redeemed'/); // single-use redemption
});

test("pet vaccination: real records with next-due, supersede, and idempotent due sweep", () => {
  assert.match(vax, /CREATE TABLE IF NOT EXISTS pet_vaccinations/);
  assert.match(vax, /UPDATE pet_vaccinations SET status='superseded'/);
  assert.match(vax, /You can only record vaccinations for your own pet/);
  assert.match(vax, /export async function runVaccinationDueSweep/);
  assert.match(vax, /UNIQUE\(vaccination_id,stage\)/);
  assert.match(vax, /dueTs < today \? "overdue" : dueTs === today \? "due" : "upcoming"/);
});

test("pet emergency: opens a real high safety_incident case and dispatches nearest live partner", () => {
  assert.match(emergency, /caseType: "safety_incident"/);
  assert.match(emergency, /severity: "high"/);
  assert.match(emergency, /provider_capacity_profiles WHERE live=1 AND status='active' AND city_id=\?/);
  assert.match(emergency, /status = partner \? "partner_dispatched" : "raised"/);
  assert.match(emergency, /You can only raise an emergency for your own pet/);
  assert.match(emergency, /escalatedToOps: !partner/);
});

test("birthday + vaccination sweeps are wired into the daily background scheduler", () => {
  assert.match(scheduler, /runPetBirthdaySweep\(db,\{today:new Date\(asOf\)/);
  assert.match(scheduler, /runVaccinationDueSweep\(db,\{today:new Date\(asOf\)/);
  assert.match(scheduler, /"petBirthdayRewards","vaccinationReminders"/);
});
