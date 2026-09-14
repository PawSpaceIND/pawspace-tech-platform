/*
 * Grooming Maps: doorstep location, provider GPS and the Routes adapter, executed for real.
 *
 * This file used to read seven source files and assert that `requireCustomerOwnership(`,
 * `GPS_CAPTURE_STATES=new Set([...])`, `X-Goog-Api-Key` and similar strings appeared in them. A
 * string in a file cannot tell whether a stranger's doorstep write is refused, whether a stale fix is
 * stored as evidence rather than as a location, or whether the server key ever leaves the server.
 *
 * Every case below drives the REAL route handlers and lib/grooming-maps.ts against SQLite through the
 * D1 adapter, with platform-session cookies issued the way the OTP routes issue them, and reads the
 * rows back. The one third party - Google Routes - is captured at the fetch boundary so the request
 * the adapter actually sends is what is asserted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { setupJourney, runCompletedJourney, routeCall, sessionCookie } from "./helpers/grooming-journey-harness.mjs";

const maps = await import("../lib/grooming-maps.ts");
const { saveGroomingServiceLocation } = await import("../lib/grooming-location-client.ts");

const ROUTE = "../../app/api/grooming-route/route.ts";
const LOCATION = "../../app/api/grooming-service-location/route.ts";
const DOORSTEP = { latitude: 12.9716, longitude: 77.5946 };

function journeyConfig(overrides = {}) {
  const start = new Date(Date.now() + 3 * 86_400_000);
  start.setUTCHours(3, 30, 0, 0);
  return {
    customerId: "CUST-MAPS", customerName: "Anita", phone: "+919900000611", petSourceId: "PET-MAPS", petName: "Milo",
    cityId: "blr", zoneId: "blr-east", pincode: "560038", latitude: DOORSTEP.latitude, longitude: DOORSTEP.longitude,
    preferredProviderId: "groom_arun", groupId: "GROOM-MAPS", start: start.toISOString(), stopAfterCapture: true,
    ...overrides,
  };
}

async function assignedJourney(t, overrides) {
  const ctx = await setupJourney();
  t.after(ctx.close);
  const config = journeyConfig(overrides);
  const result = await runCompletedJourney(ctx, config);
  assert.equal(result.location.status, 201, `the journey must save its doorstep: ${JSON.stringify(result.location.body)}`);
  const providerCookie = await sessionCookie(ctx.db, "provider", result.provider.id, `provider:${result.provider.id}`);
  return { ...ctx, config, result, providerCookie };
}

const telemetry = (f, overrides = {}) => routeCall(ROUTE, "POST", "/api/grooming-route", {
  bookingId: f.result.bookingId, providerId: f.result.provider.id,
  latitude: DOORSTEP.latitude, longitude: DOORSTEP.longitude, accuracyMeters: 10, capturedAt: Date.now(),
  idempotencyKey: `maps:${Math.random().toString(36).slice(2)}`,
  ...overrides,
}, overrides.cookie ?? f.providerCookie);

const routeRead = (f, cookie) => routeCall(ROUTE, "GET", `/api/grooming-route?bookingId=${encodeURIComponent(f.result.bookingId)}&providerId=${encodeURIComponent(f.result.provider.id)}`, null, cookie ?? f.providerCookie);

// --- doorstep: customer-owned, verified against the reservation -----------------------------------

test("the doorstep location is canonical, customer-owned and verified against the booking's zone", async (t) => {
  const f = await assignedJourney(t);
  const saved = f.sqlite.prepare("SELECT customer_id,provider_id,address_text,latitude,longitude,source,status FROM booking_service_locations WHERE booking_id=?").get(f.result.bookingId);
  assert.equal(saved.customer_id, f.config.customerId);
  assert.equal(saved.provider_id, f.result.provider.id, "the doorstep row is bound to the assigned provider");
  assert.equal(saved.status, "active");
  assert.equal(saved.source, "server_geocode", "browser coordinates are never the authority; the server geocodes");
  assert.ok(Number.isFinite(saved.latitude) && Number.isFinite(saved.longitude));
  assert.match(f.result.location.body.data.navigationUrl, /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=/);
  assert.deepEqual({ city: f.result.location.body.data.cityId, zone: f.result.location.body.data.zoneId }, { city: "blr", zone: "blr-east" }, "city and zone come from the verified address, not the client");

  const payload = { bookingId: f.result.bookingId, customerId: f.config.customerId, address: "Some other doorstep near the park, Bengaluru", pincode: "560038" };
  const stranger = await sessionCookie(f.db, "customer", "CUST-STRANGER", "customer:CUST-STRANGER");
  const foreign = await routeCall(LOCATION, "POST", "/api/grooming-service-location", payload, stranger);
  assert.equal(foreign.status, 403, JSON.stringify(foreign.body));
  const impersonated = await routeCall(LOCATION, "POST", "/api/grooming-service-location", { ...payload, customerId: "CUST-STRANGER" }, f.result.customerCookie);
  assert.equal(impersonated.status, 403, "the session subject cannot write another customer's doorstep");
  const wrongZone = await routeCall(LOCATION, "POST", "/api/grooming-service-location", { ...payload, address: "1 George Town, Chennai", pincode: "600001" }, f.result.customerCookie);
  assert.equal(wrongZone.status, 409, JSON.stringify(wrongZone.body));
  assert.match(wrongZone.body.error, /does not match the booking reservation/);
  const incomplete = await routeCall(LOCATION, "POST", "/api/grooming-service-location", { ...payload, address: "short" }, f.result.customerCookie);
  assert.equal(incomplete.status, 400);
  const unchanged = f.sqlite.prepare("SELECT address_text,updated_at FROM booking_service_locations WHERE booking_id=?").get(f.result.bookingId);
  assert.equal(unchanged.address_text, saved.address_text, "no refused write touched the doorstep");
  assert.equal(unchanged.updated_at, f.sqlite.prepare("SELECT updated_at FROM booking_service_locations WHERE booking_id=?").get(f.result.bookingId).updated_at);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM security_audit_events WHERE action='grooming.service_location.save' AND resource_id=?").get(f.result.bookingId).n, 1, "only the owner's save is audited");
});

// --- provider GPS: provider-owned, travel-state gated -------------------------------------------

test("provider GPS capture is provider-owned and limited to active travel states", async (t) => {
  const f = await assignedJourney(t);
  const other = await sessionCookie(f.db, "provider", "groom_maa", "provider:groom_maa");
  const foreign = await telemetry(f, { cookie: other });
  assert.equal(foreign.status, 403, JSON.stringify(foreign.body));
  const spoofed = await telemetry(f, { providerId: "groom_maa" });
  assert.equal(spoofed.status, 403, "a provider cannot report telemetry as another provider");
  const customer = await telemetry(f, { cookie: f.result.customerCookie });
  assert.equal(customer.status, 403, "a customer session is not a provider");
  assert.equal(f.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='universal_provider_location_events'").get() ? f.sqlite.prepare("SELECT COUNT(*) n FROM universal_provider_location_events").get().n : 0, 0, "refused callers wrote no evidence");

  const accepted = await telemetry(f);
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  assert.equal(accepted.body.data.providerLocation.trustState, "accepted");
  assert.equal(accepted.body.data.travelState, "assigned");
  assert.match(accepted.body.data.navigationUrl, /origin=12\.9716%2C77\.5946/, "the navigation link starts from the provider's accepted fix");
  const stored = f.sqlite.prepare("SELECT trust_state,rejection_reason,provider_id FROM universal_provider_location_events WHERE booking_id=?").all(f.result.bookingId);
  assert.deepEqual(stored.map((row) => [row.trust_state, row.rejection_reason, row.provider_id]), [["accepted", null, f.result.provider.id]]);

  const key = "maps:fixed-key";
  const first = await telemetry(f, { idempotencyKey: key });
  const second = await telemetry(f, { idempotencyKey: key });
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body.data.duplicate, true, "the same idempotency key never stores a second observation");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM grooming_location_ingestions WHERE idempotency_key=?").get(key).n, 1);

  for (const state of ["in_service", "completed"]) {
    f.sqlite.prepare("UPDATE provider_work_orders SET status=? WHERE booking_id=?").run(state, f.result.bookingId);
    const closed = await telemetry(f);
    assert.equal(closed.status, 409, `${state}: ${JSON.stringify(closed.body)}`);
    assert.match(closed.body.error, /GPS capture is disabled outside assigned, on-the-way or arrived states/);
  }
  f.sqlite.prepare("UPDATE provider_work_orders SET status='on_the_way' WHERE booking_id=?").run(f.result.bookingId);
  const enRoute = await telemetry(f);
  assert.equal(enRoute.status, 201, JSON.stringify(enRoute.body));
  assert.equal(enRoute.body.data.travelState, "on_the_way");
  const malformed = await telemetry(f, { latitude: 123, longitude: 77.5946 });
  assert.equal(malformed.status, 400, "out-of-range coordinates never reach the pipeline");
});

test("stale, future-clock and low-accuracy fixes are stored as rejected evidence, never as the provider's location", async (t) => {
  const f = await assignedJourney(t);
  const cases = [
    ["stale", { capturedAt: Date.now() - 20 * 60_000 }, "client_capture_outside_freshness_window"],
    ["future clock", { capturedAt: Date.now() + 10 * 60_000 }, "client_capture_ahead_of_server_time"],
    ["low accuracy", { accuracyMeters: 500 }, "accuracy_outside_approved_policy"],
  ];
  for (const [label, override, reason] of cases) {
    const rejected = await telemetry(f, override);
    assert.equal(rejected.status, 422, `${label}: ${JSON.stringify(rejected.body)}`);
    assert.equal(rejected.body.error, `GPS observation rejected: ${reason}`);
    assert.equal(rejected.body.data.telemetryAccepted, false);
    assert.notEqual(rejected.body.data.providerLocation.trustState, "accepted");
    assert.equal(rejected.body.data.route, null, "no route is computed from an untrusted fix");
  }
  const evidence = f.sqlite.prepare("SELECT trust_state,rejection_reason FROM universal_provider_location_events WHERE booking_id=? ORDER BY server_received_at").all(f.result.bookingId);
  assert.deepEqual(evidence.map((row) => [row.trust_state, row.rejection_reason]), [
    ["stale", "client_capture_outside_freshness_window"],
    ["stale", "client_capture_ahead_of_server_time"],
    ["low_accuracy", "accuracy_outside_approved_policy"],
  ], "every refused fix is kept as evidence with its reason");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM route_eta_snapshots WHERE booking_id=?").get(f.result.bookingId).n, 0);
  const audits = f.sqlite.prepare("SELECT outcome FROM security_audit_events WHERE action='grooming.provider_location.update' AND resource_id=?").all(f.result.bookingId);
  assert.deepEqual(audits.map((row) => row.outcome), ["rejected", "rejected", "rejected"]);

  const read = await routeRead(f);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.data.providerLocation, null, "an untrusted fix is not the provider's location");
  assert.equal(read.body.data.route, undefined);
  assert.doesNotMatch(read.body.data.navigationUrl, /origin=/, "the navigation link has no origin until a trusted fix exists");
});

test("the route read is provider-owned and reflects the persisted snapshot after a trusted fix", async (t) => {
  const f = await assignedJourney(t);
  const other = await sessionCookie(f.db, "provider", "groom_maa", "provider:groom_maa");
  assert.equal((await routeRead(f, other)).status, 403, "another provider cannot read this route");
  assert.equal((await routeRead(f, f.result.customerCookie)).status, 403);
  const unknown = await routeCall(ROUTE, "GET", `/api/grooming-route?bookingId=NOPE&providerId=${f.result.provider.id}`, null, f.providerCookie);
  assert.equal(unknown.status, 404);

  const accepted = await telemetry(f);
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  // Without a configured Routes key the snapshot records that fact instead of inventing an ETA.
  assert.equal(accepted.body.data.route.status, "configuration_required");
  const snapshot = f.sqlite.prepare("SELECT provider_status,distance_meters,duration_seconds,map_provider FROM route_eta_snapshots WHERE booking_id=? AND provider_id=?").get(f.result.bookingId, f.result.provider.id);
  assert.deepEqual({ ...snapshot }, { provider_status: "configuration_required", distance_meters: null, duration_seconds: null, map_provider: "google_routes" });

  const read = await routeRead(f);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const data = read.body.data;
  assert.deepEqual({ lat: data.providerLocation.lat, lng: data.providerLocation.lng }, { lat: DOORSTEP.latitude, lng: DOORSTEP.longitude });
  assert.equal(data.providerLocation.eventId, accepted.body.data.providerLocation.eventId);
  assert.equal(data.route.status, "configuration_required");
  assert.equal(data.travelState, "assigned");
  assert.equal(data.addressPrecision, "full");
  assert.ok(data.destinationAddress.length > 8);
  assert.match(data.navigationUrl, /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=.+&travelmode=driving&origin=12\.9716%2C77\.5946$/);
  assert.match(data.route.error, /GOOGLE_MAPS_SERVER_API_KEY_UAT is not configured/, "the snapshot says why there is no ETA, by configuration name and never by value");
});

// --- lib/grooming-maps.ts: the Routes adapter ---------------------------------------------------

test("the Routes adapter is locked to sandbox with a server-only key and never forwards a malformed origin", async () => {
  const env = globalThis.__GROOM_GOLDEN_ENV__ ?? (globalThis.__GROOM_GOLDEN_ENV__ = {});
  const originalFetch = globalThis.fetch;
  const originalKey = env.GOOGLE_MAPS_SERVER_API_KEY_UAT, originalMode = env.PAWSPACE_MAPS_ENV;
  const calls = [];
  const KEY = "server-only-sandbox-key-9f2c";
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(String(init.body)) });
    return Response.json({ routes: [{ duration: "540s", distanceMeters: 4200, polyline: { encodedPolyline: "abc" } }] });
  };
  try {
    env.PAWSPACE_MAPS_ENV = "sandbox";
    delete env.GOOGLE_MAPS_SERVER_API_KEY_UAT;
    assert.deepEqual(await maps.computeGoogleRoute(DOORSTEP_POINT(), "12 MG Road"), { status: "configuration_required", error: "GOOGLE_MAPS_SERVER_API_KEY_UAT is not configured" });
    env.GOOGLE_MAPS_SERVER_API_KEY_UAT = KEY;
    env.PAWSPACE_MAPS_ENV = "live";
    assert.equal((await maps.computeGoogleRoute(DOORSTEP_POINT(), "12 MG Road")).status, "configuration_required", "the UAT adapter refuses to run outside sandbox");
    env.PAWSPACE_MAPS_ENV = "sandbox";
    assert.equal(calls.length, 0, "no provider call is spent before configuration is proven");

    assert.equal((await maps.computeGoogleRoute({ lat: Number.NaN, lng: 77.5 }, "12 MG Road")).status, "route_unavailable");
    assert.equal((await maps.computeGoogleRoute({ lat: 12.97, lng: 200 }, "12 MG Road")).status, "route_unavailable");
    assert.equal((await maps.computeGoogleRoute(DOORSTEP_POINT(), "   ")).status, "route_unavailable");
    assert.equal(calls.length, 0, "a malformed origin or empty destination never reaches Google");

    const route = await maps.computeGoogleRoute(DOORSTEP_POINT(), "12 MG Road, Bengaluru");
    assert.deepEqual(route, { status: "configured", provider: "google_routes", distanceMeters: 4200, durationSeconds: 540, polyline: "abc" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://routes.googleapis.com/directions/v2:computeRoutes");
    assert.equal(calls[0].headers["X-Goog-Api-Key"], KEY, "the server key is sent to Google and nowhere else");
    assert.equal(calls[0].headers["X-Goog-FieldMask"], "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline");
    assert.deepEqual(calls[0].body.origin, { location: { latLng: { latitude: DOORSTEP.latitude, longitude: DOORSTEP.longitude } } });
    assert.equal(calls[0].body.destination.address, "12 MG Road, Bengaluru");

    globalThis.fetch = async () => Response.json({ routes: [{}] });
    assert.equal((await maps.computeGoogleRoute(DOORSTEP_POINT(), "12 MG Road")).status, "route_unavailable", "a 200 without distance and duration is not a route");
    globalThis.fetch = async () => Response.json({ routes: [{ duration: "90s", distanceMeters: null }] });
    assert.equal((await maps.computeGoogleRoute(DOORSTEP_POINT(), "12 MG Road")).status, "route_unavailable", "a null distance is not zero metres");
    globalThis.fetch = async () => Response.json({ error: { message: "quota" } }, { status: 429 });
    assert.deepEqual(await maps.computeGoogleRoute(DOORSTEP_POINT(), "12 MG Road"), { status: "route_unavailable", error: "quota" });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete env.GOOGLE_MAPS_SERVER_API_KEY_UAT; else env.GOOGLE_MAPS_SERVER_API_KEY_UAT = originalKey;
    if (originalMode === undefined) delete env.PAWSPACE_MAPS_ENV; else env.PAWSPACE_MAPS_ENV = originalMode;
  }
});

function DOORSTEP_POINT() { return { lat: DOORSTEP.latitude, lng: DOORSTEP.longitude }; }

test("the server key never reaches a provider response, even when a route is configured", async (t) => {
  const f = await assignedJourney(t);
  const env = globalThis.__GROOM_GOLDEN_ENV__;
  const originalFetch = globalThis.fetch;
  const KEY = "server-only-sandbox-key-leak-check";
  globalThis.fetch = async () => Response.json({ routes: [{ duration: "300s", distanceMeters: 2500 }] });
  try {
    env.GOOGLE_MAPS_SERVER_API_KEY_UAT = KEY;
    const accepted = await telemetry(f);
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    assert.deepEqual({ status: accepted.body.data.route.status, distance: accepted.body.data.route.distanceMeters, duration: accepted.body.data.route.durationSeconds }, { status: "configured", distance: 2500, duration: 300 });
    const read = await routeRead(f);
    assert.equal(read.body.data.route.status, "configured");
    assert.equal(read.body.data.route.distanceMeters, 2500);
    const snapshot = f.sqlite.prepare("SELECT provider_status,distance_meters,duration_seconds,predicted_arrival_at FROM route_eta_snapshots WHERE booking_id=? ORDER BY calculated_at DESC LIMIT 1").get(f.result.bookingId);
    assert.deepEqual({ status: snapshot.provider_status, distance: snapshot.distance_meters, duration: snapshot.duration_seconds }, { status: "configured", distance: 2500, duration: 300 });
    assert.ok(snapshot.predicted_arrival_at > Date.now(), "a configured route persists a forecast arrival");
    for (const payload of [accepted.body, read.body]) assert.equal(JSON.stringify(payload).includes(KEY), false, "the key stays on the server");
  } finally {
    globalThis.fetch = originalFetch;
    delete env.GOOGLE_MAPS_SERVER_API_KEY_UAT;
  }
});

// --- lib/grooming-location-client.ts -------------------------------------------------------------

test("the customer client posts the canonical booking's doorstep to the governed endpoint and surfaces its refusal", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, body: JSON.parse(String(init.body)) });
    if (calls.length === 1) return Response.json({ data: { bookingId: "PS-1", addressSaved: true, coordinatesSaved: true, navigationUrl: "https://www.google.com/maps/dir/?api=1" } }, { status: 201 });
    return Response.json({ error: "The verified address zone does not match the booking reservation" }, { status: 409 });
  };
  try {
    const input = { bookingId: "PS-1", customerId: "CUST-1", address: "14 Indiranagar 100 Feet Road, Bengaluru 560038", latitude: 12.97, longitude: 77.64 };
    const saved = await saveGroomingServiceLocation(input);
    assert.equal(saved.addressSaved, true);
    assert.deepEqual(calls[0], { url: "/api/grooming-service-location", method: "POST", body: input }, "the canonical booking id and the session customer id are what is sent");
    await assert.rejects(saveGroomingServiceLocation(input), /does not match the booking reservation/, "the governed refusal reaches the customer verbatim");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
