import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";
import { createD1 } from "./helpers/d1.mjs";

// Test-only resolve hook (same pattern as tests/customer-offers.test.mjs).
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      try { return nextResolve(specifier, context); } catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `export async function resolve(specifier, context, nextResolve) {
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const staysRoute = read("app/api/boarding-stays/route.ts");
const sittingRoute = read("app/api/sitting-lifecycle/route.ts");
const statementsOf = (source) =>
  [...source.matchAll(/\.prepare\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g)].map((m) => m[2].replace(/\\(["'`\\])/g, "$1"));

// D1's batch() is one transaction. The loop this replaced committed each statement as it went, so a
// lifecycle transition that failed half way left the stay in a state production would have rolled
// back - the class of defect the #177 review found and this file could not have seen.
const makeD1 = (sqlite) => createD1(sqlite);

const DAY = 86_400_000;
const NOW = Date.now();
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

async function stayStack() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  // Real DDL through the real ensure chains + extraction for cross-module tables.
  for (const source of [read("app/api/grooming-lifecycle/route.ts"), read("app/api/uat-scheduling/route.ts"), read("lib/provider-capacity-governance.ts")]) {
    for (const sql of statementsOf(source)) if (/^\s*CREATE (TABLE|INDEX|UNIQUE INDEX)/i.test(sql)) sqlite.exec(sql);
  }
  const boardingProof = await import("../lib/boarding-proof-governance.ts");
  const sittingProof = await import("../lib/sitting-proof-governance.ts");
  await boardingProof.ensureBoardingProofTables(db);
  await sittingProof.ensureSittingProofTables(db);
  const lifecycle = await import("../lib/boarding-stay-lifecycle.ts");
  const sitting = await import("../lib/sitting-lifecycle.ts");
  const payments = await import("../lib/stay-split-payments.ts");
  const finalizer = await import("../lib/sitting-recovery-finalizer.ts");
  await payments.ensureStayPaymentTables(db);

  const seedHost = (providerId, { maxGuestPets = 2, oneFamilyOnly = 0 } = {}) => {
    sqlite.prepare("INSERT OR IGNORE INTO boarding_host_profiles (provider_id,city_id,zone_id,area,species_json,max_guest_pets,one_family_only,medication_support,resident_pets,home_verified,kyc_status,background_check_status,active,version,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(providerId, "blr", "blr-east", "Indiranagar", '["dog","cat"]', maxGuestPets, oneFamilyOnly, 1, "none", 1, "verified", "verified", 1, 1, "test", NOW);
    sqlite.prepare("INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(providerId, "blr", providerId, "commission", '["boarding","pet_sitting"]', '["blr-east"]', 1, 4.9, 95, 4, 30, 6, 3, "active", 1, "2026-01-01", null, "test", NOW);
  };
  const seedBooking = ({ bookingId, customerId = "CUS-STAY-1", providerId, service = "boarding", groupId, start, end, status = "confirmed", amount = 4500 }) => {
    sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(bookingId, `ik-${bookingId}`, customerId, "[]", "[]", "blr", "blr-east", service, `${service}-std`, `${service} package`, groupId, providerId, start, end, status, "customer_app", amount, "INR", "{}", "test", NOW, NOW);
  };
  const seedStay = ({ stayId, bookingId, customerId = "CUS-STAY-1", providerId, start, end, petCount = 1, status = "awaiting_host_acceptance", carePlan = "required" }) => {
    sqlite.prepare("INSERT INTO boarding_stays (id,booking_id,customer_id,host_provider_id,city_id,zone_id,package_code,check_in_at,check_out_at,billed_units,pet_count,status,care_plan_status,check_in_status,check_out_status,extension_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(stayId, bookingId, customerId, providerId, "blr", "blr-east", "boarding-std", start, end, 3, petCount, status, carePlan, "pending", "pending", "none", NOW, NOW);
  };
  const seedOffer = (groupId, providerId, { status = "pending", expiresAt = NOW + 3_600_000 } = {}) => {
    sqlite.prepare("INSERT OR REPLACE INTO provider_assignment_offers (group_id,booking_id,provider_id,status,offered_at,expires_at,responded_at,response_reason,attempt_no,updated_at) VALUES (?,?,?,?,?,?,NULL,NULL,1,?)")
      .run(groupId, null, providerId, status, NOW, expiresAt, NOW);
  };
  return { sqlite, db, lifecycle, sitting, payments, finalizer, boardingProof, sittingProof, seedHost, seedBooking, seedStay, seedOffer };
}

const rejects = async (promise, status, pattern) => {
  let caught = null;
  try { await promise; } catch (error) { caught = error; }
  assert.ok(caught instanceof Response, `expected a Response rejection matching ${pattern}`);
  assert.equal(caught.status, status);
  assert.match(await caught.text(), pattern);
};

const mutate = (stack, stayId, action, extra = {}) =>
  stack.lifecycle.mutateBoardingStay(stack.db, { stayId, action, actorId: extra.actorId ?? "host@test", idempotencyKey: extra.idempotencyKey ?? `${stayId}-${action}-${Math.random().toString(36).slice(2)}`, ...extra });

// ---------------------------------------------------------------------------
// 1. Full state machine, real execution.
// ---------------------------------------------------------------------------
test("real execution: awaiting_host_acceptance -> accept -> care plan -> check-in -> care events -> extension -> check-out -> completed", async () => {
  const stack = await stayStack();
  const { sqlite } = stack;
  stack.seedHost("host_maya");
  stack.seedBooking({ bookingId: "BK-S1", providerId: "host_maya", groupId: "GRP-S1", start: iso(2 * DAY), end: iso(5 * DAY) });
  stack.seedStay({ stayId: "STAY-1", bookingId: "BK-S1", providerId: "host_maya", start: iso(2 * DAY), end: iso(5 * DAY) });
  stack.seedOffer("GRP-S1", "host_maya");

  // Check-in is impossible before acceptance, and care events before check-in.
  await rejects(mutate(stack, "STAY-1", "check_in"), 409, /Host acceptance is required/);
  await rejects(mutate(stack, "STAY-1", "care_event", { careEventType: "meal" }), 409, /only during an active stay/);

  const accepted = await mutate(stack, "STAY-1", "accept");
  assert.equal(accepted.status, "confirmed");
  assert.equal(sqlite.prepare("SELECT status FROM provider_assignment_offers WHERE group_id='GRP-S1'").get().status, "accepted");
  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id='BK-S1'").get().status, "assigned");
  assert.equal(sqlite.prepare("SELECT status FROM boarding_capacity_locks WHERE stay_id='STAY-1'").get().status, "active");

  // Care plan gate: check-in blocked until a valid plan is submitted.
  await rejects(mutate(stack, "STAY-1", "check_in"), 409, /ready care plan is required/);
  await rejects(mutate(stack, "STAY-1", "submit_care_plan", { carePlan: { feeding: "2x" } }), 409, /emergency contact and vet/);
  await mutate(stack, "STAY-1", "submit_care_plan", { actorId: "customer@test", carePlan: { emergencyContact: "9999900701", vet: "Dr Rao", feeding: "2x" } });

  const checkedIn = await mutate(stack, "STAY-1", "check_in");
  assert.equal(checkedIn.status, "in_progress");
  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id='BK-S1'").get().status, "in_progress");

  const care = await mutate(stack, "STAY-1", "care_event", { careEventType: "walk", detail: { minutes: 30 } });
  assert.equal(care.status, "logged");

  // Extension: must extend beyond current checkout, never changes the stay window itself.
  await rejects(mutate(stack, "STAY-1", "request_extension", { requestedEnd: iso(4 * DAY) }), 400, /later than the current checkout/);
  const extension = await mutate(stack, "STAY-1", "request_extension", { actorId: "customer@test", requestedEnd: iso(7 * DAY) });
  assert.equal(extension.status, "commercial_quote_required", "extension always goes through a server commercial quote");
  assert.equal(extension.stayWindowUnchanged, true);
  assert.equal(sqlite.prepare("SELECT check_out_at FROM boarding_stays WHERE id='STAY-1'").get().check_out_at, iso(5 * DAY), "requesting an extension never moves the paid window");

  const done = await mutate(stack, "STAY-1", "check_out", { idempotencyKey: "STAY-1-check-out-key" });
  assert.equal(done.status, "completed");
  assert.equal(sqlite.prepare("SELECT status FROM boarding_capacity_locks WHERE stay_id='STAY-1'").get().status, "released");
  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id='BK-S1'").get().status, "completed");
  // Idempotent replay of the SAME consumed key returns the remembered result instead of re-executing.
  const replay = await mutate(stack, "STAY-1", "check_out", { idempotencyKey: "STAY-1-check-out-key" });
  assert.equal(replay.duplicatePrevented, true, "a consumed idempotency key must be replay-safe");
  assert.equal(replay.status, "completed");
  // A different key re-executes and is correctly refused on an already-completed stay.
  await rejects(mutate(stack, "STAY-1", "check_out"), 409, /checked-in active stay/);
});

test("real execution: decline, offer timeout and no_show all branch into governed recovery", async () => {
  const stack = await stayStack();
  const { sqlite } = stack;
  stack.seedHost("host_maya");
  for (const [stayId, bookingId, groupId] of [["STAY-D", "BK-D", "GRP-D"], ["STAY-T", "BK-T", "GRP-T"], ["STAY-N", "BK-N", "GRP-N"]]) {
    stack.seedBooking({ bookingId, providerId: "host_maya", groupId, start: iso(2 * DAY), end: iso(4 * DAY) });
    stack.seedStay({ stayId, bookingId, providerId: "host_maya", start: iso(2 * DAY), end: iso(4 * DAY) });
  }
  stack.seedOffer("GRP-D", "host_maya");
  stack.seedOffer("GRP-T", "host_maya", { expiresAt: NOW - 60_000 }); // already timed out

  await rejects(mutate(stack, "STAY-D", "decline", { reason: "x" }), 400, /recovery reason is required/);
  const declined = await mutate(stack, "STAY-D", "decline", { reason: "Family emergency" });
  assert.equal(declined.status, "ops_escalation");
  assert.equal(sqlite.prepare("SELECT status FROM boarding_stays WHERE id='STAY-D'").get().status, "recovery_pending");
  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id='BK-D'").get().status, "reassignment_needed");
  assert.equal(sqlite.prepare("SELECT reason_code FROM boarding_recovery_cases WHERE stay_id='STAY-D'").get().reason_code, "decline");

  // Timed-out offer cannot be accepted — recovery is the only path.
  await rejects(mutate(stack, "STAY-T", "accept"), 409, /offer expired/);

  const noShow = await mutate(stack, "STAY-N", "no_show", { actorId: "ops@test", reason: "Customer did not arrive" });
  assert.equal(noShow.status, "ops_escalation");
  assert.equal(sqlite.prepare("SELECT reason_code FROM boarding_recovery_cases WHERE stay_id='STAY-N'").get().reason_code, "no_show");
});

test("regression: the capacity lock is atomic — concurrent-style overfill and one-family conflicts are refused at write time", async () => {
  const stack = await stayStack();
  stack.seedHost("host_two", { maxGuestPets: 2 });
  stack.seedBooking({ bookingId: "BK-A", providerId: "host_two", groupId: "GRP-A", start: iso(2 * DAY), end: iso(5 * DAY) });
  stack.seedStay({ stayId: "STAY-A", bookingId: "BK-A", providerId: "host_two", start: iso(2 * DAY), end: iso(5 * DAY), petCount: 1 });
  stack.seedBooking({ bookingId: "BK-B", customerId: "CUS-STAY-2", providerId: "host_two", groupId: "GRP-B", start: iso(3 * DAY), end: iso(6 * DAY) });
  stack.seedStay({ stayId: "STAY-B", bookingId: "BK-B", customerId: "CUS-STAY-2", providerId: "host_two", start: iso(3 * DAY), end: iso(6 * DAY), petCount: 2 });
  stack.seedOffer("GRP-A", "host_two");
  await mutate(stack, "STAY-A", "accept");
  stack.seedOffer("GRP-B", "host_two");
  await rejects(mutate(stack, "STAY-B", "accept"), 409, /capacity is no longer available/);

  // One-family-only host: a second overlapping family is refused even with spare pet capacity.
  stack.seedHost("host_solo", { maxGuestPets: 4, oneFamilyOnly: 1 });
  stack.seedBooking({ bookingId: "BK-F1", providerId: "host_solo", groupId: "GRP-F1", start: iso(2 * DAY), end: iso(5 * DAY) });
  stack.seedStay({ stayId: "STAY-F1", bookingId: "BK-F1", providerId: "host_solo", start: iso(2 * DAY), end: iso(5 * DAY), petCount: 1 });
  stack.seedBooking({ bookingId: "BK-F2", customerId: "CUS-STAY-3", providerId: "host_solo", groupId: "GRP-F2", start: iso(3 * DAY), end: iso(6 * DAY) });
  stack.seedStay({ stayId: "STAY-F2", bookingId: "BK-F2", customerId: "CUS-STAY-3", providerId: "host_solo", start: iso(3 * DAY), end: iso(6 * DAY), petCount: 1 });
  stack.seedOffer("GRP-F1", "host_solo");
  await mutate(stack, "STAY-F1", "accept");
  stack.seedOffer("GRP-F2", "host_solo");
  await rejects(mutate(stack, "STAY-F2", "accept"), 409, /one family at a time/);
});

test("real execution: an extension is capacity-re-checked against overlapping locks", async () => {
  const stack = await stayStack();
  const { sqlite } = stack;
  stack.seedHost("host_ext", { maxGuestPets: 2 });
  stack.seedBooking({ bookingId: "BK-E", providerId: "host_ext", groupId: "GRP-E", start: iso(1 * DAY), end: iso(3 * DAY) });
  stack.seedStay({ stayId: "STAY-E", bookingId: "BK-E", providerId: "host_ext", start: iso(1 * DAY), end: iso(3 * DAY), petCount: 1 });
  stack.seedOffer("GRP-E", "host_ext");
  await mutate(stack, "STAY-E", "accept");
  // Another family fully books the host right after this stay's checkout.
  sqlite.prepare("INSERT INTO boarding_capacity_locks (stay_id,booking_id,provider_id,starts_at,ends_at,capacity_units,family_key,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'active',?,?)")
    .run("STAY-LOCKED", "BK-LOCKED", "host_ext", iso(3 * DAY), iso(6 * DAY), 2, "CUS-OTHER", NOW, NOW);
  await rejects(mutate(stack, "STAY-E", "request_extension", { requestedEnd: iso(5 * DAY) }), 409, /capacity is no longer available/);
});

// ---------------------------------------------------------------------------
// 2. NEW split-payment interaction: unpaid balance blocks check-in.
// ---------------------------------------------------------------------------
test("real execution: an unpaid 50/50 balance blocks Boarding check-in; paying it unblocks", async () => {
  const stack = await stayStack();
  stack.seedHost("host_pay");
  stack.seedBooking({ bookingId: "BK-PAY", providerId: "host_pay", groupId: "GRP-PAY", start: iso(3 * DAY), end: iso(6 * DAY), amount: 6000 });
  stack.seedStay({ stayId: "STAY-PAY", bookingId: "BK-PAY", providerId: "host_pay", start: iso(3 * DAY), end: iso(6 * DAY) });
  stack.seedOffer("GRP-PAY", "host_pay");
  await mutate(stack, "STAY-PAY", "accept");
  await mutate(stack, "STAY-PAY", "submit_care_plan", { actorId: "customer@test", carePlan: { emergencyContact: "9999900702", vet: "Dr Rao" } });

  // Real split plan through the real lib, persisted with the real statement helper.
  const plan = stack.payments.splitPaymentPlan({ totalAmount: 6000, scheduledStart: iso(3 * DAY) });
  assert.equal(plan.dueNow, 3000);
  assert.equal(plan.balance, 3000);
  await stack.payments.staySplitScheduleStatement(stack.db, { bookingId: "BK-PAY", serviceCode: "boarding", customerId: "CUS-STAY-1", totalAmount: 6000, paidNowAmount: plan.dueNow, balanceAmount: plan.balance, balanceDueAt: plan.balanceDueAt }).run();

  await rejects(mutate(stack, "STAY-PAY", "check_in"), 409, /remaining 50% stay balance must be paid before check-in/);

  // Overdue balances block identically.
  await stack.db.prepare("UPDATE stay_payment_schedules SET balance_due_at=? WHERE booking_id='BK-PAY'").bind(NOW - DAY).run();
  const swept = await stack.payments.sweepOverdueStayBalances(stack.db);
  assert.equal(swept.marked, 1);
  await rejects(mutate(stack, "STAY-PAY", "check_in"), 409, /balance must be paid before check-in/);

  // Pay the balance -> check-in succeeds.
  const paid = await stack.payments.payStayBalance(stack.db, { bookingId: "BK-PAY", actorId: "customer@test", idempotencyKey: "bal-1" });
  assert.equal(paid.schedule.status, "paid");
  const checkedIn = await mutate(stack, "STAY-PAY", "check_in");
  assert.equal(checkedIn.status, "in_progress");
});

test("real execution: the same balance guard protects Sitting check-in", async () => {
  const stack = await stayStack();
  const { sqlite } = stack;
  stack.seedHost("sitter_neha");
  stack.seedBooking({ bookingId: "BK-SIT", providerId: "sitter_neha", service: "pet_sitting", groupId: "GRP-SIT", start: iso(3 * DAY), end: iso(5 * DAY), status: "assigned", amount: 2400 });
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,occurrence_count,status,assignment_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("WO-SIT", "BK-SIT", "GRP-SIT", "sitter_neha", "Neha", "commission", "pet_sitting", iso(3 * DAY), iso(5 * DAY), 1, "assigned", "{}", NOW, NOW);
  await stack.sitting.mutateSittingBooking(stack.db, { bookingId: "BK-SIT", action: "submit_care_plan", actorId: "customer@test", idempotencyKey: "sit-plan-1", carePlan: { emergencyContact: "9999900703", vet: "Dr Rao", homeAccess: "Lockbox 4321" } });

  const plan = stack.payments.splitPaymentPlan({ totalAmount: 2400, scheduledStart: iso(3 * DAY) });
  await stack.payments.staySplitScheduleStatement(stack.db, { bookingId: "BK-SIT", serviceCode: "pet_sitting", customerId: "CUS-STAY-1", totalAmount: 2400, paidNowAmount: plan.dueNow, balanceAmount: plan.balance, balanceDueAt: plan.balanceDueAt }).run();

  await rejects(stack.sitting.mutateSittingBooking(stack.db, { bookingId: "BK-SIT", action: "check_in", actorId: "sitter@test", idempotencyKey: "sit-ci-1" }), 409, /balance must be paid before check-in/);
  await stack.payments.payStayBalance(stack.db, { bookingId: "BK-SIT", actorId: "customer@test", idempotencyKey: "sit-bal-1" });
  const checkedIn = await stack.sitting.mutateSittingBooking(stack.db, { bookingId: "BK-SIT", action: "check_in", actorId: "sitter@test", idempotencyKey: "sit-ci-2" });
  assert.equal(checkedIn.status, "in_progress");
});

test("split plan purity: within-24h stays cannot split; halves are exact", async () => {
  const { splitPaymentPlan } = await import("../lib/stay-split-payments.ts");
  await rejects(Promise.resolve().then(() => splitPaymentPlan({ totalAmount: 4000, scheduledStart: iso(12 * 3_600_000) })), 409, /more than 24 hours/);
  const plan = splitPaymentPlan({ totalAmount: 4999, scheduledStart: iso(3 * DAY) });
  assert.equal(plan.dueNow + plan.balance, 4999);
  assert.equal(plan.balanceDueAt, new Date(iso(3 * DAY)).getTime() - 24 * 3_600_000);
});

// ---------------------------------------------------------------------------
// 3. Proof events cannot be self-approved.
// ---------------------------------------------------------------------------
test("regression: proof media cannot be scan-approved by its submitter, incidents cannot be self-resolved or self-acknowledged", async () => {
  const stack = await stayStack();
  stack.seedHost("host_proof");
  stack.seedBooking({ bookingId: "BK-PR", providerId: "host_proof", groupId: "GRP-PR", start: iso(1 * DAY), end: iso(4 * DAY) });
  stack.seedStay({ stayId: "STAY-PR", bookingId: "BK-PR", providerId: "host_proof", start: iso(1 * DAY), end: iso(4 * DAY), status: "confirmed", carePlan: "ready" });

  const proof = stack.boardingProof;
  const prep = await proof.mutateBoardingProof(stack.db, { stayId: "STAY-PR", action: "prepare_media", actorId: "host@test", idempotencyKey: "pr-1", purpose: "stay_update", mimeType: "image/jpeg", sizeBytes: 5000, sha256: "a".repeat(64) });
  await proof.mutateBoardingProof(stack.db, { stayId: "STAY-PR", action: "sandbox_finalize_media", actorId: "host@test", idempotencyKey: "pr-2", uploadToken: prep.upload.token, storageObjectId: "objects/stay-pr-0001" });

  // The submitting actor cannot approve their own scan.
  await rejects(
    proof.mutateBoardingProof(stack.db, { stayId: "STAY-PR", action: "record_media_scan", actorId: "host@test", idempotencyKey: "pr-3", mediaRef: prep.mediaRef, scanResult: "clean" }),
    403, /cannot be scan-approved by the actor who submitted it/
  );
  // A different (ops) actor can.
  const scanned = await proof.mutateBoardingProof(stack.db, { stayId: "STAY-PR", action: "record_media_scan", actorId: "ops@test", idempotencyKey: "pr-4", mediaRef: prep.mediaRef, scanResult: "clean" });
  assert.equal(scanned.scanStatus, "clean");

  const incident = await proof.mutateBoardingProof(stack.db, { stayId: "STAY-PR", action: "report_incident", actorId: "host@test", idempotencyKey: "pr-5", severity: "attention", summary: "Minor scratch observed during play" });
  await rejects(
    proof.mutateBoardingProof(stack.db, { stayId: "STAY-PR", action: "acknowledge_incident", actorId: "host@test", idempotencyKey: "pr-6", incidentId: incident.incidentId }),
    403, /cannot be acknowledged by the actor who reported it/
  );
  await rejects(
    proof.mutateBoardingProof(stack.db, { stayId: "STAY-PR", action: "resolve_incident", actorId: "host@test", idempotencyKey: "pr-7", incidentId: incident.incidentId, resolution: "Cleaned and monitored" }),
    403, /cannot be resolved by the actor who reported it/
  );
  const resolved = await proof.mutateBoardingProof(stack.db, { stayId: "STAY-PR", action: "resolve_incident", actorId: "ops@test", idempotencyKey: "pr-8", incidentId: incident.incidentId, resolution: "Cleaned and monitored, customer informed" });
  assert.equal(resolved.status, "resolved");
  // The sitting proof lib carries the identical guards.
  const sittingProofSource = read("lib/sitting-proof-governance.ts");
  assert.match(sittingProofSource, /cannot be scan-approved by the actor who submitted it/);
  assert.match(sittingProofSource, /cannot be resolved by the actor who reported it/);
  assert.match(sittingProofSource, /cannot be acknowledged by the actor who reported it/);
});

// ---------------------------------------------------------------------------
// 4. Sitting recovery finalizer consistency.
// ---------------------------------------------------------------------------
test("real execution: sitting recovery accept + finalize enforce canonical consistency", async () => {
  const stack = await stayStack();
  const { sqlite } = stack;
  stack.seedHost("sitter_replacement");
  stack.seedBooking({ bookingId: "BK-REC", providerId: "sitter_replacement", service: "pet_sitting", groupId: "GRP-REC", start: iso(2 * DAY), end: iso(4 * DAY), status: "reassignment_offered" });
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,occurrence_count,status,assignment_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("WO-REC", "BK-REC", "GRP-REC", "sitter_replacement", "Replacement", "commission", "pet_sitting", iso(2 * DAY), iso(4 * DAY), 1, "reassignment_offered", "{}", NOW, NOW);
  sqlite.prepare("INSERT INTO sitting_recovery_cases (id,booking_id,group_id,failed_provider_id,reason_code,status,replacement_provider_id,detail_json,opened_at,resolved_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,NULL,?)")
    .run("REC-1", "BK-REC", "GRP-REC", "sitter_failed", "sitter_unavailable", "replacement_offered", "sitter_replacement", "{}", NOW, NOW);
  sqlite.prepare("INSERT INTO provider_assignment_offers (group_id,booking_id,provider_id,status,offered_at,expires_at,responded_at,response_reason,attempt_no,updated_at) VALUES (?,?,?,?,?,?,NULL,NULL,2,?)")
    .run("GRP-REC", "BK-REC", "sitter_replacement", "pending", NOW, NOW + 3_600_000, NOW);
  sqlite.prepare("INSERT INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,reason,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run("GRP-REC", "recovery", "[]", "sitter_replacement", "reassignment_offered", "ops@test", "recovery", NOW);
  sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("RES-REC", "GRP-REC", "sitter_replacement", "pet_sitting", "blr", "blr-east", "CUS-STAY-1", "[]", iso(2 * DAY), iso(4 * DAY), 1, 1, null, "reassignment_offered", "{}", NOW);

  const accepted = await stack.finalizer.acceptSittingRecoveryOffer(stack.db, "BK-REC", "sitter@test", "rec-accept-1");
  assert.equal(accepted.status, "assigned");
  assert.equal(sqlite.prepare("SELECT status FROM provider_assignment_offers WHERE group_id='GRP-REC'").get().status, "accepted");

  const finalized = await stack.finalizer.finalizeSittingRecoveryAcceptance(stack.db, "BK-REC", "ops@test");
  assert.equal(finalized.bookingPreserved, true);
  assert.equal(sqlite.prepare("SELECT status FROM scheduling_reservations WHERE id='RES-REC'").get().status, "assigned");

  // A mismatched replacement provider is refused before any state change.
  sqlite.prepare("UPDATE sitting_recovery_cases SET replacement_provider_id='sitter_wrong' WHERE id='REC-1'").run();
  await rejects(stack.finalizer.finalizeSittingRecoveryAcceptance(stack.db, "BK-REC", "ops@test"), 409, /inconsistent across canonical records/);
});

// ---------------------------------------------------------------------------
// 5. Permission boundaries per action (route posture).
// ---------------------------------------------------------------------------
test("boarding-stays route splits customer/host/staff permissions per action", () => {
  assert.match(staysRoute, /providerActions=new Set<BoardingStayAction>\(\["accept","decline","check_in","care_event","host_unavailable","check_out"\]\)/);
  assert.match(staysRoute, /customerActions=new Set<BoardingStayAction>\(\["submit_care_plan","request_extension"\]\)/);
  assert.match(staysRoute, /if\(action==="no_show"\)\{requirePermission\(actor,"bookings\.manage"\);\}/, "no_show is staff-only");
  assert.match(staysRoute, /requireProviderOwnership\(db,actor,providerId\)/, "host actions demand host ownership");
  assert.match(staysRoute, /requireCustomerOwnership\(db,actor,customerId\)/, "customer actions demand customer ownership");
  assert.match(staysRoute, /Medication, photo proof and incidents must use the governed Boarding proof workflow/, "evidence care events cannot bypass proof governance");
  assert.match(staysRoute, /Customer Boarding stay reads require only a booking ID/, "customer scope cannot enumerate by provider/customer");
  assert.match(sittingRoute, /providerActions=new Set<SittingAction>\(\["accept","decline","check_in","care_event","sitter_unavailable","check_out"\]\)/);
});
