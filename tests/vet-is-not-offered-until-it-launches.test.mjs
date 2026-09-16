/*
 * The service picker offered Doorstep Vet to customers, and it cannot be booked by anyone.
 *
 * No provider record anywhere in this repository lists vet_consult among its services;
 * lib/marketing-landing-content.ts marks both Doorstep Vet landing pages paused:true; and reserving a
 * vet slot answers NO_SCHEDULE_AVAILABLE with an EMPTY evaluation list - not "everyone is busy", but
 * "there is nobody". /api/service-availability nevertheless published it as enabled=true, because the
 * seed in lib/service-control.ts enabled every service in the catalogue.
 *
 * So a customer could choose Vet Consultation and reach a dead end phrased as a temporary capacity
 * problem. Found by driving every vertical's booking flow against the running worker.
 *
 * The seed is INSERT OR IGNORE, so this decides what a database that has never seen the service says.
 * Anywhere an operator has already enabled it, their decision stands - which is what makes this safe
 * to ship and what makes launching the service a staff action rather than a code change.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { installWorkersHooks, enterWorkersDbScope } from "./helpers/module-hooks.mjs";

installWorkersHooks("__VET_LAUNCH_DB__");

async function world() {
  const harness = freshCountingD1();
  globalThis.__VET_LAUNCH_DB__ = harness.db;
  enterWorkersDbScope(harness.db);
  const control = await import("../lib/service-control.ts");
  await control.ensureServiceControlTables(harness.db);
  return { harness, control };
}

test("VET-1: a fresh database does not offer Doorstep Vet, and says why", async () => {
  const { harness, control } = await world();
  const services = await control.listServiceControls(harness.db);
  const vet = services.find((s) => s.code === "vet_consult");
  assert.ok(vet, "the service stays in the catalogue - it is not launched, not deleted");
  assert.equal(vet.enabled, false, "a service nobody can deliver must not be offered");
  assert.match(vet.disabledReason ?? "", /has not launched/i,
    "and the reason must say it has not launched, not imply everyone is busy");
});

test("VET-2: every service that IS deliverable is still offered", async () => {
  // The guard must narrow to the one unlaunched service, not quietly disable the platform.
  const { harness, control } = await world();
  const services = await control.listServiceControls(harness.db);
  const live = services.filter((s) => s.enabled).map((s) => s.code).sort();
  assert.deepEqual(live, ["boarding", "dog_training", "dog_walking", "food", "funeral_memorial",
    "grooming", "pet_sitting", "pet_taxi", "relocation"],
    "every vertical with real providers stays enabled");
  for (const service of services) {
    if (service.enabled) assert.equal(service.disabledReason, null, `${service.code} is enabled and needs no reason`);
  }
});

test("VET-3: a decision an operator has already made is never overwritten", async () => {
  /*
   * The seed is INSERT OR IGNORE by design. The day a vet is onboarded, staff enable the service
   * through the governed control and its audit trail - and a later deploy must not silently undo it.
   */
  const { harness, control } = await world();
  await harness.db.prepare("UPDATE service_controls SET enabled=1,disabled_reason=NULL,updated_by='ops.admin' WHERE service_code='vet_consult'").run();
  await control.ensureServiceControlTables(harness.db); // a later deploy re-runs the seed
  const vet = (await control.listServiceControls(harness.db)).find((s) => s.code === "vet_consult");
  assert.equal(vet.enabled, true, "the operator's decision must survive the seed");
  assert.equal(vet.updatedBy, "ops.admin", "and stay attributed to them");
});
