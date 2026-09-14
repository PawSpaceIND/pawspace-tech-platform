import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { setupJourney, runCompletedJourney, routeCall, sessionCookie } from "./helpers/grooming-journey-harness.mjs";
import { d1 } from "./helpers/execution-harness.mjs";

/*
 * Work Order 02: Grooming Maps used to be seven regexes over source text. It now executes
 * lib/grooming-maps.ts against node:sqlite and drives the real /api/grooming-route and
 * /api/grooming-service-location handlers through the real session + ownership path on a real
 * booking produced by the governed journey. One source assertion remains, because it is the only
 * way to prove a secret is ABSENT from client code.
 */
const maps = await import("../lib/grooming-maps.ts");
const source = (path) => readFile(new URL("../" + path, import.meta.url), "utf8");

test("map tables, route snapshots and provider points are real rows, and the navigation URL is built from them", async (t) => {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  const db = d1(sqlite);
  await maps.ensureGroomingMapTables(db);
  await maps.ensureGroomingMapTables(db); // idempotent, including the ALTER TABLE upgrade path
  assert.deepEqual(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('booking_service_locations','provider_location_events','grooming_route_snapshots') ORDER BY name").all().map((r) => r.name), ["booking_service_locations", "grooming_route_snapshots", "provider_location_events"]);
  assert.equal(await maps.latestProviderPoint(db, "BKG-1", "groom_arun"), null);
  sqlite.prepare("INSERT INTO provider_location_events (id,booking_id,provider_id,latitude,longitude,accuracy_meters,captured_at,created_at) VALUES ('E1','BKG-1','groom_arun',12.97,77.59,25,1000,1000),('E2','BKG-1','groom_arun',12.98,77.60,10,2000,2000),('E3','BKG-1','groom_other',1,1,1,3000,3000)").run();
  assert.deepEqual(await maps.latestProviderPoint(db, "BKG-1", "groom_arun"), { lat: 12.98, lng: 77.6, accuracyMeters: 10, capturedAt: 2000 }, "the newest point for THIS provider, not the newest row");
  await maps.saveRouteSnapshot(db, { bookingId: "BKG-1", providerId: "groom_arun", origin: { lat: 12.98, lng: 77.6 }, destinationAddress: "42 Indiranagar Double Road", route: { status: "configured", provider: "google_routes", distanceMeters: 4200, durationSeconds: 900 } });
  const snapshot = { ...sqlite.prepare("SELECT booking_id,provider_id,origin_latitude,destination_address,distance_meters,duration_seconds,route_status FROM grooming_route_snapshots").get() };
  assert.deepEqual(snapshot, { booking_id: "BKG-1", provider_id: "groom_arun", origin_latitude: 12.98, destination_address: "42 Indiranagar Double Road", distance_meters: 4200, duration_seconds: 900, route_status: "configured" });
  const url = new URL(maps.mapsNavigationUrl("42 Indiranagar Double Road", { lat: 12.98, lng: 77.6 }));
  assert.equal(url.origin + url.pathname, "https://www.google.com/maps/dir/");
  assert.equal(url.searchParams.get("destination"), "42 Indiranagar Double Road");
  assert.equal(url.searchParams.get("origin"), "12.98,77.6");
  assert.equal(url.searchParams.get("travelmode"), "driving");
  assert.equal(new URL(maps.mapsNavigationUrl("x")).searchParams.has("origin"), false);
  for (const bad of [null, undefined, { lat: NaN, lng: 1 }, { lat: 91, lng: 0 }, { lat: 0, lng: -181 }]) assert.equal(maps.validRoutePoint(bad), false);
  assert.equal(maps.validRoutePoint({ lat: -90, lng: 180 }), true);
});

test("Routes API credentials are server-only: locked to sandbox, refused without a key, sent only as X-Goog-Api-Key, never in client code", async (t) => {
  const ctx = await setupJourney(); t.after(ctx.close);
  const env = globalThis.__GROOM_GOLDEN_ENV__;
  const origin = { lat: 12.97, lng: 77.59 };
  assert.deepEqual(await maps.computeGoogleRoute(origin, "MG Road"), { status: "configuration_required", error: "GOOGLE_MAPS_SERVER_API_KEY_UAT is not configured" });
  env.PAWSPACE_MAPS_ENV = "production"; env.GOOGLE_MAPS_SERVER_API_KEY_UAT = "test-key";
  assert.equal((await maps.computeGoogleRoute(origin, "MG Road")).status, "configuration_required", "the adapter is locked to sandbox");
  env.PAWSPACE_MAPS_ENV = "sandbox";
  const realFetch = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify({ routes: [{ duration: "900s", distanceMeters: 4200, polyline: { encodedPolyline: "abc" } }] }), { status: 200, headers: { "content-type": "application/json" } }); };
  t.after(() => { globalThis.fetch = realFetch; delete env.GOOGLE_MAPS_SERVER_API_KEY_UAT; env.PAWSPACE_MAPS_ENV = "sandbox"; });
  assert.deepEqual(await maps.computeGoogleRoute({ lat: NaN, lng: 1 }, "MG Road"), { status: "route_unavailable", error: "Origin coordinates are missing or out of range" });
  assert.equal(calls.length, 0, "a malformed origin never reaches the provider");
  const route = await maps.computeGoogleRoute(origin, "MG Road");
  assert.deepEqual(route, { status: "configured", provider: "google_routes", distanceMeters: 4200, durationSeconds: 900, polyline: "abc" });
  assert.equal(calls[0].url, "https://routes.googleapis.com/directions/v2:computeRoutes");
  assert.equal(calls[0].init.headers["X-Goog-Api-Key"], "test-key");
  assert.equal(calls[0].init.headers["X-Goog-FieldMask"], "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline");
  assert.equal(String(calls[0].init.body).includes("test-key"), false, "the key travels in a header, never in the body");
  globalThis.fetch = async () => new Response(JSON.stringify({ routes: [{ distanceMeters: null }] }), { status: 200 });
  assert.equal((await maps.computeGoogleRoute(origin, "MG Road")).status, "route_unavailable", "a 200 without usable distance and duration is not a route");
  const routeCard = await source("app/partner-app/grooming-route-card.tsx");
  assert.doesNotMatch(routeCard, /GOOGLE_MAPS_SERVER_API_KEY_UAT|X-Goog-Api-Key/, "the client bundle carries no server credential");
});

test("/api/grooming-route is provider-owned and GPS capture only exists in assigned, on-the-way or arrived states", async (t) => {
  const ctx = await setupJourney(); t.after(ctx.close);
  const start = new Date(Date.now() + 3 * 86400000); start.setUTCHours(3, 30, 0, 0);
  const config = { customerId: "CUST-MAPS-1", customerName: "Mira", phone: "+919900000616", petSourceId: "PET-MAPS", petName: "Milo", cityId: "blr", zoneId: "blr-east", pincode: "560038", latitude: 12.9716, longitude: 77.5946, preferredProviderId: "groom_arun", groupId: "GROOM-MAPS-1", start: start.toISOString(), stopAfterCapture: true };
  const result = await runCompletedJourney(ctx, config);
  const { bookingId, provider, customerCookie } = result;
  const doorstep = ctx.sqlite.prepare("SELECT latitude,longitude FROM booking_service_locations WHERE booking_id=?").get(bookingId);
  const gps = (extra = {}) => ({ bookingId, providerId: provider.id, latitude: doorstep.latitude, longitude: doorstep.longitude, accuracyMeters: 10, capturedAt: Date.now(), ...extra });
  const post = (body, cookie) => routeCall("../../app/api/grooming-route/route.ts", "POST", "/api/grooming-route", body, cookie);

  const asCustomer = await post(gps(), customerCookie);
  assert.equal(asCustomer.status, 403, JSON.stringify(asCustomer.body));
  const otherProvider = await sessionCookie(ctx.db, "provider", "groom_kiran", "provider:groom_kiran");
  const asStranger = await post(gps(), otherProvider);
  assert.equal(asStranger.status, 403, "another provider cannot report position for this booking");
  const anonymous = await (await import("../app/api/grooming-route/route.ts")).POST(new Request("https://app.pawspace.in/api/grooming-route", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(gps()) }));
  assert.ok([401, 403].includes(anonymous.status), `anonymous caller must be refused, got ${anonymous.status}`);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM universal_provider_location_events WHERE booking_id=?").get(bookingId).n, 0, "no refused caller wrote telemetry");

  const providerCookie = await sessionCookie(ctx.db, "provider", provider.id, `provider:${provider.id}`);
  const invalid = await post(gps({ latitude: 999 }), providerCookie);
  assert.equal(invalid.status, 400);
  const accepted = await post(gps({ idempotencyKey: `maps:${bookingId}:1` }), providerCookie);
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  const replay = await post(gps({ idempotencyKey: `maps:${bookingId}:1` }), providerCookie);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.duplicate, true);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM universal_provider_location_events WHERE booking_id=? AND trust_state='accepted'").get(bookingId).n, 1);

  const read = await routeCall("../../app/api/grooming-route/route.ts", "GET", `/api/grooming-route?bookingId=${bookingId}&providerId=${provider.id}`, null, providerCookie);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.data.providerLocation.lat, doorstep.latitude);
  assert.equal(read.body.data.travelState, "assigned");
  if (read.body.data.navigationUrl) assert.match(read.body.data.navigationUrl, /^https:\/\/www\.google\.com\/maps\/dir\//);
  const readAsCustomer = await routeCall("../../app/api/grooming-route/route.ts", "GET", `/api/grooming-route?bookingId=${bookingId}&providerId=${provider.id}`, null, customerCookie);
  assert.equal(readAsCustomer.status, 403);

  ctx.sqlite.prepare("UPDATE provider_work_orders SET status='completed' WHERE booking_id=?").run(bookingId);
  const late = await post(gps({ idempotencyKey: `maps:${bookingId}:2` }), providerCookie);
  assert.equal(late.status, 409);
  assert.match(late.body.error, /GPS capture is disabled outside assigned, on-the-way or arrived states/);
  ctx.sqlite.prepare("UPDATE provider_work_orders SET status='on_the_way' WHERE booking_id=?").run(bookingId);
  const travelling = await post(gps({ idempotencyKey: `maps:${bookingId}:3` }), providerCookie);
  assert.equal(travelling.status, 201, JSON.stringify(travelling.body));
});

test("/api/grooming-service-location keeps the doorstep customer-owned, server-geocoded and zone-consistent", async (t) => {
  const ctx = await setupJourney(); t.after(ctx.close);
  const start = new Date(Date.now() + 4 * 86400000); start.setUTCHours(5, 30, 0, 0);
  const config = { customerId: "CUST-MAPS-2", customerName: "Ravi", phone: "+919900000617", petSourceId: "PET-MAPS-2", petName: "Coco", cityId: "blr", zoneId: "blr-east", pincode: "560038", latitude: 12.9716, longitude: 77.5946, preferredProviderId: "groom_arun", groupId: "GROOM-MAPS-2", start: start.toISOString(), stopAfterCapture: true };
  const result = await runCompletedJourney(ctx, config);
  const { bookingId, customerCookie } = result;
  const body = (extra = {}) => ({ bookingId, customerId: config.customerId, address: "Ravi service address, Indiranagar 560038", pincode: "560038", ...extra });
  const post = (payload, cookie) => routeCall("../../app/api/grooming-service-location/route.ts", "POST", "/api/grooming-service-location", payload, cookie);
  const saved = ctx.sqlite.prepare("SELECT customer_id,provider_id,source,status FROM booking_service_locations WHERE booking_id=?").get(bookingId);
  assert.equal(saved.customer_id, config.customerId);
  assert.equal(saved.source, "server_geocode", "browser coordinates are never location authority");
  assert.equal(saved.status, "active");

  const stranger = await sessionCookie(ctx.db, "customer", "CUST-MAPS-STRANGER", "customer:CUST-MAPS-STRANGER");
  const notOwner = await post(body(), stranger);
  assert.equal(notOwner.status, 403, JSON.stringify(notOwner.body));
  const spoofed = await post(body({ customerId: "CUST-MAPS-STRANGER" }), stranger);
  assert.ok([403, 404].includes(spoofed.status), "a stranger cannot re-point the booking by naming themselves");
  const anonymous = await (await import("../app/api/grooming-service-location/route.ts")).POST(new Request("https://app.pawspace.in/api/grooming-service-location", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body()) }));
  assert.ok([401, 403].includes(anonymous.status), `anonymous caller must be refused, got ${anonymous.status}`);
  const incomplete = await post(body({ address: "short", pincode: "" }), customerCookie);
  assert.equal(incomplete.status, 400);
  const wrongZone = await post(body({ address: "Ravi service address, George Town 600001", pincode: "600001" }), customerCookie);
  assert.equal(wrongZone.status, 409, JSON.stringify(wrongZone.body));
  assert.equal(ctx.sqlite.prepare("SELECT customer_id FROM booking_service_locations WHERE booking_id=?").get(bookingId).customer_id, config.customerId, "every refusal left the saved doorstep untouched");
  const resaved = await post(body(), customerCookie);
  assert.equal(resaved.status, 201, JSON.stringify(resaved.body));
  assert.equal(resaved.body.data.coordinateSource, "server_geocode");
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM booking_service_locations WHERE booking_id=?").get(bookingId).n, 1, "upsert, not a second row");
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM security_audit_events WHERE action='grooming.service_location.save' AND resource_id=?").get(bookingId).n >= 1, true);
});
