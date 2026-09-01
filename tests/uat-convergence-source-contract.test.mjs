import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read=(path)=>fs.readFileSync(new URL(`../${path}`,import.meta.url),"utf8");

test("UAT convergence: scheduling and Training controls are wired",()=>{
  const scheduling=read("backend/src/scheduling.ts");
  const route=read("app/api/uat-scheduling/route.ts");
  const providers=read("lib/provider-capacity-governance.ts");
  const training=read("lib/training-session-lifecycle.ts");
  const commercial=read("lib/training-commercial-governance.ts");
  assert.match(scheduling,/haversineDistanceKm/);
  assert.match(scheduling,/serviceRadiusKm/);
  assert.match(route,/latitude/);
  assert.match(route,/longitude/);
  assert.match(route,/serviceRadiusKm/);
  assert.match(providers,/currentHomeBase/);
  assert.match(commercial,/PARTIALLY_PAID/);
  assert.match(commercial,/FULLY_PAID/);
  assert.match(commercial,/collectTrainingRemainingBalanceSandbox/);
  assert.match(training,/TRAINING_ARRIVAL_GEOFENCE_METERS/);
  assert.match(training,/owner_handover/);
  assert.match(training,/training_completion_certificates/);
  assert.match(training,/training_customer_notifications/);
  assert.match(training,/status=\x27locked\x27|status='locked'/);
  assert.match(training,/CLOSED/);
});

test("UAT convergence: Taxi GPS hard blocker is removed",()=>{
  const route=read("app/api/location-recovery/route.ts");
  assert.doesNotMatch(route,/Taxi remains outside active GPS UAT scope/);
  assert.match(route,/gpsConnected/);
});
