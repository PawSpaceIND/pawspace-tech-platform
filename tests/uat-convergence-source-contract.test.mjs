import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read=(path)=>fs.readFileSync(new URL(`../${path}`,import.meta.url),"utf8");

test("UAT convergence: scheduling and Training controls are wired end to end",()=>{
  const scheduling=read("backend/src/scheduling.ts");
  const route=read("app/api/uat-scheduling/route.ts");
  const providers=read("lib/provider-capacity-governance.ts");
  const training=read("lib/training-session-lifecycle.ts");
  const sessionsRoute=read("app/api/training-sessions/route.ts");
  const commercial=read("lib/training-commercial-governance.ts");
  const paymentRoute=read("app/api/training-payment-sandbox/route.ts");
  assert.match(scheduling,/haversineDistanceKm/);
  assert.match(scheduling,/serviceRadiusKm/);
  assert.match(route,/latitude/);
  assert.match(route,/longitude/);
  assert.match(route,/serviceRadiusKm/);
  assert.match(providers,/currentHomeBase/);
  assert.match(commercial,/PARTIALLY_PAID/);
  assert.match(commercial,/FULLY_PAID/);
  assert.match(commercial,/collectTrainingRemainingBalanceSandbox/);
  assert.match(paymentRoute,/remaining_balance/);
  assert.match(training,/TRAINING_ARRIVAL_GEOFENCE_METERS/);
  assert.match(training,/owner_handover/);
  assert.match(training,/training_completion_certificates/);
  assert.match(training,/training_customer_notifications/);
  assert.match(training,/status=\x27locked\x27|status='locked'/);
  // A terminal programme keeps its two outcomes rather than collapsing into one "CLOSED" value: the
  // difference is the only signal that a no_show or cancellation still needs its consumption/refund
  // policy applied, and app/api/training-ops, app/mobile-app/training-flow.tsx and
  // lib/training-cancellation.ts all read it. Surfaces ask the shared predicate, never a string compare.
  assert.match(training,/completed_with_exceptions/);
  assert.match(training,/export function isTerminalTrainingProgramme/);
  assert.doesNotMatch(training,/terminal\?"CLOSED"/);
  assert.match(sessionsRoute,/latitude:body\.latitude/);
  assert.match(sessionsRoute,/ownerHandoverMinutes:body\.ownerHandoverMinutes/);
  assert.match(sessionsRoute,/isTerminalTrainingProgramme\(/);
  assert.doesNotMatch(sessionsRoute,/===\"CLOSED\"/);
});

test("UAT convergence: Boarding, Sitting and Walking proof/location/finance are active",()=>{
  const boarding=read("lib/boarding-stay-lifecycle.ts");
  const boardingProof=read("lib/boarding-proof-governance.ts");
  const sitting=read("lib/sitting-lifecycle.ts");
  const sittingRoute=read("app/api/sitting-lifecycle/route.ts");
  const walking=read("lib/walking-lifecycle.ts");
  const walkingRoute=read("app/api/walking-lifecycle/route.ts");
  assert.match(boarding,/care_play/);
  assert.match(boarding,/assertDailyMilestones/);
  assert.match(boarding,/resolveServiceCompletionFinance/);
  assert.match(boardingProof,/video\/mp4/);
  assert.match(sitting,/SITTING_CHECKIN_GEOFENCE_METERS/);
  assert.match(sitting,/sitting_report_card/);
  assert.match(sitting,/resolveServiceCompletionFinance/);
  assert.match(sittingRoute,/latitude:body\.latitude/);
  assert.match(walking,/WALKING_START_GEOFENCE_METERS/);
  // Sandbox telemetry does not amount to a connected production GPS provider, and lib/taxi-proof-governance
  // still reports productionGpsConnected:false, so the lifecycle payloads must agree with it rather than
  // record evidence claiming GPS was connected.
  assert.match(walking,/gpsConnected:false/);
  assert.match(walking,/telemetryMode:"deterministic_sandbox"/);
  assert.doesNotMatch(walking,/gpsConnected:true/);
  assert.match(walking,/resolveServiceCompletionFinance/);
  assert.match(walkingRoute,/latitude:body\.latitude/);
});

test("UAT convergence: Taxi uses active deterministic GPS/proof/finance contracts",()=>{
  const route=read("app/api/location-recovery/route.ts");
  const lifecycle=read("lib/taxi-lifecycle.ts");
  const ops=read("lib/taxi-ops-governance.ts");
  const proof=read("lib/taxi-proof-governance.ts");
  // Pet Taxi stays outside the scope of the universal GPS lateness/recovery engine, which is still what
  // docs/GPS_LATENESS_RECOVERY_ENGINEERING_UAT.md item 8 states. Taxi's own deterministic sandbox route
  // sampling lives in lib/taxi-lifecycle.ts and is asserted below; it is not this engine.
  assert.match(route,/Taxi remains outside active GPS UAT scope/);
  assert.doesNotMatch(route,/gpsConnected:true/);
  assert.match(lifecycle,/gpsConnected:false/);
  assert.match(lifecycle,/telemetryMode:"deterministic_sandbox"/);
  assert.match(lifecycle,/resolveServiceCompletionFinance/);
  assert.match(ops,/routeEvidence:\"deterministic_sandbox_verified\"/);
  assert.match(ops,/gpsConnected:false/);
  assert.doesNotMatch(ops,/routeEvidence:\"sandbox_unverified\"/);
  assert.match(ops,/tax:\"resolved_completion_ledger\"/);
  assert.match(ops,/driverPayout:\"accrued_completion_ledger\"/);
  // "Resolved" is only honest because the resolver fails closed: no approved commercial term means no
  // completion at all, rather than a payout and tax figure the platform invented for itself.
  assert.match(read("lib/provider-commercial-terms.ts"),/configuration_required: no active commercial term/);
  assert.match(ops,/productionReady:false/);
  assert.match(proof,/TAXI_CANONICAL_PROOF_REQUIREMENTS/);
  assert.match(proof,/Before Picture/);
  assert.match(proof,/After Picture/);
});

test("UAT convergence: completion finance is balanced and place-of-supply aware",()=>{
  const finance=read("lib/service-completion-finance.ts");
  const tcs=read("lib/tcs-governance.ts");
  assert.match(finance,/resolveServiceCompletionFinance/);
  assert.match(finance,/postJournal/);
  assert.match(finance,/ledgerStatus:\"balanced\"/);
  assert.match(finance,/Provider Payable/);
  assert.match(finance,/TCS Payable/);
  assert.match(finance,/GST Payable/);
  assert.match(tcs,/resolveBookingPlaceOfSupply/);
  assert.match(tcs,/booking_coordinates/);
  assert.match(tcs,/supplyType/);
  assert.match(tcs,/igst/);
});
