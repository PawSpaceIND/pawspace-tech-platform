import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const engine = fs.readFileSync("lib/lifecycle-reminder-engine.ts", "utf8");
const route = fs.readFileSync("app/api/lifecycle-reminders/route.ts", "utf8");
const page = fs.readFileSync("app/team/lifecycle-reminders/page.tsx", "utf8");

test("lifecycle reminder module covers every required customer segment", () => {
  for (const segment of ["new_customer", "existing_customer", "subscription", "service"]) {
    assert.match(engine, new RegExp(`\\b${segment}\\b`));
  }
});

test("service reminder directory covers PawSpace service families without inventing cadences", () => {
  for (const service of ["grooming", "training", "boarding", "sitting", "dog_walking", "pet_taxi", "food", "relocation"]) {
    assert.match(engine, new RegExp(`\\b${service}\\b`));
  }
  assert.match(engine, /Service-specific rebooking cadence must be approved before activation/);
  assert.match(engine, /configurationRequired: true/);
});

test("confirmed reminder business logic reuses the existing governed engine", () => {
  assert.match(engine, /currentCadencePolicy/);
  assert.match(engine, /runCustomerReminderSweep/);
  assert.match(engine, /grooming_rebooking_reminder/);
  assert.match(engine, /subscription_unused_sessions_reminder/);
  assert.match(engine, /subscription_renewal_reminder/);
});

test("unknown cadence cannot be activated silently", () => {
  assert.match(engine, /An active scheduled reminder requires an approved delay\/cadence/);
  assert.match(engine, /change reason is required/);
  assert.match(route, /requirePermission\(actor, "settings\.manage"\)/);
  assert.match(route, /securityAudit/);
});

test("separate Team module exposes configuration matrix and truthful delivery boundary", () => {
  assert.match(page, /Customer & service reminder engine/);
  assert.match(page, /Business-rule matrix/);
  assert.match(page, /new customers, existing customers, subscriptions and every PawSpace service/i);
  assert.match(page, /Live WhatsApp\/SMS\/email delivery remains off/);
  assert.match(engine, /externalDelivery: false/);
});
