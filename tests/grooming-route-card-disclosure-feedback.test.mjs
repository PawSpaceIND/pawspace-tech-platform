import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as nodeModule from "node:module";

// lib/* imports its siblings without a file extension, so resolution needs the same retry hook the
// other executed suites install. Static imports hoist above it, hence the dynamic imports below.
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

const { APPROVED_DATA_ACCESS, decideCustomerDataAccess } = await import("../lib/purpose-based-access.ts");
const { classifyGpsObservation, shouldApplyTelemetryResponse } = await import("../lib/gps-telemetry-policy.ts");

// ---------------------------------------------------------------------------
// What the route card tells the partner when the doorstep is withheld, or a fix is refused.
//
// /api/grooming-route returns addressPrecision on BOTH verbs. The card's RouteData never declared it,
// so when the policy narrowed the address the destination and the turn-by-turn link simply vanished
// behind the generic "Verified customer doorstep" placeholder - which reads as a value rather than as an
// absence, with nothing on screen to say why or who to ask.
//
// Separately, a refused fix comes back as a 422 carrying the classified verdict in `data`. The card
// applied `data` only on a 2xx, so trustState and rejectionReason were discarded and the partner got a
// raw "GPS observation rejected: accuracy_outside_approved_policy".
//
// The precision and trust verdicts below come from the real policy functions, not from fixtures.
// ---------------------------------------------------------------------------

const card = readFileSync(new URL("../app/partner-app/grooming-route-card.tsx", import.meta.url), "utf8");
const route = readFileSync(new URL("../app/api/grooming-route/route.ts", import.meta.url), "utf8");

const subject = {
  customerId: "CU-1",
  name: "Customer",
  address: { line1: "12 Example Cross", area: "Koramangala", city: "Bengaluru", pincode: "560034" },
};
const actor = { email: "provider:groom_arun", roleCode: "service_provider", permissions: ["bookings.view"] };

/** The disclosure /api/grooming-route computes, for a booking in the given state. */
const disclose = ({ status, completedAt, now = Date.now() }) => decideCustomerDataAccess(APPROVED_DATA_ACCESS, {
  actor,
  subject,
  purpose: "service_delivery",
  assignment: { type: "booking", id: "BK-1", assignedTo: "groom_arun", status, scheduledStart: now + 3_600_000, completedAt },
  now,
});

test("an active assignment really does get the full doorstep", () => {
  const decision = disclose({ status: "on_the_way", completedAt: null });
  assert.equal(decision.address.precision, "full");
  assert.equal(decision.address.line1, "12 Example Cross",
    "the common case must keep working - this test is about the other branches");
});

test("past the dispute window the policy withholds the address entirely", () => {
  const now = Date.now();
  const completedAt = now - (APPROVED_DATA_ACCESS.providerDisputeWindowHours + 1) * 3_600_000;
  const decision = disclose({ status: "completed", completedAt, now });
  assert.equal(decision.address.precision, "none", "this is the state the card rendered as a placeholder");
  assert.equal(decision.address.line1, null);
});

test("the route returns that precision on both verbs, so the card can explain itself", () => {
  const occurrences = route.match(/addressPrecision:disclosure\.precision/g) ?? [];
  assert.equal(occurrences.length, 2, "GET and POST each return it");
  // And it only ever sends an address the policy projected.
  assert.match(route, /destinationAddress:disclosure\.destinationAddress/);
  assert.match(route, /navigationUrl:disclosure\.destinationAddress\?/,
    "no navigation link is offered for an address the policy withheld");
});

test("the card declares the precision and turns each narrowed value into a reason", () => {
  assert.match(card, /addressPrecision\?:AddressPrecision/, "the field was previously undeclared and dropped");
  assert.match(card, /precisionNote\(data\.addressPrecision\)/, "declaring it is not showing it");
  for (const precision of ["area", "billing", "none"]) {
    assert.match(card, new RegExp(`precision==="${precision}"`), `${precision} needs its own explanation`);
  }
  assert.match(card, /Doorstep not shared yet/,
    "a withheld address must not read as if the placeholder were the destination");
});

test("every trust verdict the classifier can refuse has partner-facing copy", () => {
  const base = {
    latitude: 12.93, longitude: 77.62, accuracyMeters: 10,
    clientCapturedAt: 1_000_000, serverReceivedAt: 1_000_500,
    freshnessSeconds: 60, allowedAccuracyMeters: 50, gpsIngestionEnabled: true,
  };
  // Drive the real classifier into each refusal rather than listing reason strings by hand.
  const refusals = [
    classifyGpsObservation({ ...base, gpsIngestionEnabled: false }),
    classifyGpsObservation({ ...base, latitude: 999 }),
    classifyGpsObservation({ ...base, clientCapturedAt: 0 }),
    classifyGpsObservation({ ...base, freshnessSeconds: 0 }),
    classifyGpsObservation({ ...base, allowedAccuracyMeters: 0 }),
    classifyGpsObservation({ ...base, clientCapturedAt: base.serverReceivedAt + 60_000 }),
    classifyGpsObservation({ ...base, clientCapturedAt: base.serverReceivedAt - 120_000 }),
    classifyGpsObservation({ ...base, accuracyMeters: Number.NaN }),
    classifyGpsObservation({ ...base, accuracyMeters: -1 }),
    classifyGpsObservation({ ...base, accuracyMeters: 500 }),
  ];
  const reasons = new Set(refusals.map((verdict) => verdict.reason));
  assert.equal(refusals.length, reasons.size, "each case must produce a distinct reason");
  for (const verdict of refusals) {
    assert.notEqual(verdict.trustState, "accepted");
    assert.match(card, new RegExp(`\\b${verdict.reason}:`),
      `${verdict.reason} is a verdict the partner can be shown and needs its own sentence`);
  }
  // An unknown future reason must still read as a sentence rather than as a bare token.
  assert.match(card, /REJECTION_NOTE\[reason\]\|\|`That fix was not accepted/);
});

test("an accepted observation produces no refusal copy path", () => {
  const verdict = classifyGpsObservation({
    latitude: 12.93, longitude: 77.62, accuracyMeters: 10,
    clientCapturedAt: 1_000_000, serverReceivedAt: 1_000_500,
    freshnessSeconds: 60, allowedAccuracyMeters: 50, gpsIngestionEnabled: true,
  });
  assert.equal(verdict.trustState, "accepted");
  assert.equal(verdict.reason, null);
});

test("a refused fix is explained without discarding the last trusted route", () => {
  assert.match(card, /response\.status===422\)setRejection/, "the 422's verdict must be kept, not dropped");
  assert.match(card, /The last trusted fix and ETA above are unchanged/);
  // The rejection is separate state precisely so it cannot overwrite `data`.
  assert.match(card, /const\[rejection,setRejection\]/);
  assert.doesNotMatch(card, /if\(response\.status===422\)setData/,
    "merging a rejected payload would null out a good ETA");
  assert.match(card, /if\(response\.ok\)\{setData/);
});

test("out-of-order responses are still discarded by sequence", () => {
  // The rejection path runs inside the same sequence guard, so it cannot resurrect a stale verdict.
  assert.match(card, /shouldApplyTelemetryResponse\(seq,lastAppliedSequence\.current\)/);
  assert.equal(shouldApplyTelemetryResponse(2, 3), false);
  assert.equal(shouldApplyTelemetryResponse(4, 3), true);
});

test("a refused-fix warning does not follow the partner to another booking", () => {
  // rejection describes ONE booking's refused fix: it is cleared by a 200 or replaced by a later 422.
  // The effect keyed on the booking reset tracking, the watch and the in-flight controller but not
  // this, so switching jobs left the previous booking's amber GPS warning under the new job's route.
  const card = readFileSync(new URL("../app/partner-app/grooming-route-card.tsx", import.meta.url), "utf8");
  const effect = card.slice(card.indexOf("mounted.current=true;"));
  const body = effect.slice(0, effect.indexOf("},[bookingId,providerId,managedTracking]);"));
  assert.match(body, /setRejection\(null\)/, "the per-booking reset must drop the previous rejection");
  assert.ok(body.indexOf("setRejection(null)") < body.indexOf("void load()"),
    "it must be cleared before the new booking's route is requested");
});
