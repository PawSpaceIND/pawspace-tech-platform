/*
 * Day-31 cross-module test 6: the Maps/Routes adapter, driven against a stubbed provider.
 *
 * coordinate validation -> environment lock -> outbound request shape -> what counts as a route ->
 * timeout -> navigation URL construction.
 *
 * The adapter is the only place in the platform that hands customer/partner geodata to a third
 * party and turns a third party's answer into an ETA a customer is shown. Two failure directions
 * matter and they are opposites: sending Google something malformed (a NaN coordinate serialises
 * to null in the request body, so the refusal looks like a provider fault rather than ours), and
 * believing an answer Google did not actually give (HTTP 200 carrying an empty route object is not
 * a route, and Number() is not a validator - Number(null) is 0).
 *
 * The provider is stubbed at global fetch so the request body itself can be inspected. No real
 * Google call is made and no API key is needed beyond a fixture value.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world } from "./helpers/execution-harness.mjs";

installWorkersHooks("__D31_MAPS_DB__", "__D31_MAPS_ENV__");

const BLR = { lat: 12.9716, lng: 77.5946 };
const DESTINATION = "42 Ranga Rao Road, Shankarapuram, Bengaluru 560004";

/** Install a stubbed Routes API and return the calls it received. */
function stubRoutes(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : null });
    return handler(calls.length, init);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function maps(env = { PAWSPACE_MAPS_ENV: "sandbox", GOOGLE_MAPS_SERVER_API_KEY_UAT: "uat-fixture-key" }) {
  world("__D31_MAPS_DB__", "__D31_MAPS_ENV__", env);
  return import("../lib/grooming-maps.ts");
}

test("coordinate validation accepts real points and refuses everything that is not one", async () => {
  const { validRoutePoint } = await maps();
  for (const good of [BLR, { lat: 0, lng: 0 }, { lat: 90, lng: 180 }, { lat: -90, lng: -180 }]) {
    assert.equal(validRoutePoint(good), true, `must accept ${JSON.stringify(good)}`);
  }
  const bad = [
    null, undefined, {},
    { lat: Number.NaN, lng: 77 }, { lat: 12, lng: Number.NaN },
    { lat: Infinity, lng: 77 }, { lat: 90.0001, lng: 0 }, { lat: -90.0001, lng: 0 },
    { lat: 0, lng: 180.0001 }, { lat: 0, lng: -180.0001 },
    { lat: "12.9716", lng: "77.5946" },
  ];
  for (const point of bad) {
    assert.equal(validRoutePoint(point), false, `must refuse ${JSON.stringify(point)}`);
  }
});

test("a malformed coordinate never reaches the provider", async () => {
  /*
   * The refusal has to happen BEFORE the call, not after. NaN serialises to null in JSON, so a
   * coordinate we failed to validate arrives at Google as a malformed request - which bills us,
   * leaks the rest of the payload, and returns an error we would then have to interpret.
   */
  const { computeGoogleRoute } = await maps();
  const stub = stubRoutes(() => jsonResponse({ routes: [{ distanceMeters: 100, duration: "60s" }] }));
  try {
    const result = await computeGoogleRoute({ lat: Number.NaN, lng: 77.5946 }, DESTINATION);
    assert.equal(result.status, "route_unavailable");
    assert.equal(stub.calls.length, 0, "no provider call may be spent on a coordinate we already know is bad");

    const noDestination = await computeGoogleRoute(BLR, "   ");
    assert.equal(noDestination.status, "route_unavailable");
    assert.equal(stub.calls.length, 0, "an empty destination must not reach the provider either");
  } finally { stub.restore(); }
});

test("the adapter is locked to sandbox and refuses without a configured key", async () => {
  const stub = stubRoutes(() => jsonResponse({ routes: [{ distanceMeters: 1, duration: "1s" }] }));
  try {
    const live = await maps({ PAWSPACE_MAPS_ENV: "live", GOOGLE_MAPS_SERVER_API_KEY_UAT: "uat-fixture-key" });
    const lockedOut = await live.computeGoogleRoute(BLR, DESTINATION);
    assert.equal(lockedOut.status, "configuration_required");
    assert.match(lockedOut.error, /locked to sandbox/);

    const keyless = await maps({ PAWSPACE_MAPS_ENV: "sandbox", GOOGLE_MAPS_SERVER_API_KEY_UAT: "  " });
    const unconfigured = await keyless.computeGoogleRoute(BLR, DESTINATION);
    assert.equal(unconfigured.status, "configuration_required");
    assert.equal(stub.calls.length, 0, "neither refusal may spend a provider call");
  } finally { stub.restore(); }
});

test("a good route is returned with both measures, and the request carries the key out of band", async () => {
  const { computeGoogleRoute } = await maps();
  const stub = stubRoutes(() => jsonResponse({
    routes: [{ distanceMeters: 4200, duration: "930s", polyline: { encodedPolyline: "abc123" } }],
  }));
  try {
    const route = await computeGoogleRoute(BLR, DESTINATION);
    assert.equal(route.status, "configured");
    assert.equal(route.distanceMeters, 4200);
    assert.equal(route.durationSeconds, 930);
    assert.equal(route.provider, "google_routes");

    const [call] = stub.calls;
    assert.equal(call.init.headers["X-Goog-Api-Key"], "uat-fixture-key");
    assert.doesNotMatch(call.url, /uat-fixture-key/, "the API key must not be in the URL, where it would be logged");
    assert.deepEqual(call.body.origin.location.latLng, { latitude: BLR.lat, longitude: BLR.lng });
    assert.equal(call.body.destination.address, DESTINATION);
  } finally { stub.restore(); }
});

test("HTTP 200 is not a route - a half-answer is never shown to a customer as an ETA", async () => {
  /*
   * Each shape below is a real 200 from a route provider that carries no usable answer. Reporting
   * any of them as "configured" would put a fabricated distance or a missing ETA in front of a
   * customer, and write it into the snapshot table as though the provider had said it.
   */
  const { computeGoogleRoute } = await maps();
  const halfAnswers = [
    ["no routes array", {}],
    ["empty routes array", { routes: [] }],
    ["route object with nothing in it", { routes: [{}] }],
    ["null distance", { routes: [{ distanceMeters: null, duration: "60s" }] }],
    ["string distance", { routes: [{ distanceMeters: "4200", duration: "60s" }] }],
    ["negative distance", { routes: [{ distanceMeters: -1, duration: "60s" }] }],
    ["missing duration", { routes: [{ distanceMeters: 4200 }] }],
    ["duration as an array", { routes: [{ distanceMeters: 4200, duration: ["90s"] }] }],
    ["unparseable duration", { routes: [{ distanceMeters: 4200, duration: "about 15 minutes" }] }],
  ];
  for (const [label, body] of halfAnswers) {
    const stub = stubRoutes(() => jsonResponse(body));
    try {
      const route = await computeGoogleRoute(BLR, DESTINATION);
      assert.equal(route.status, "route_unavailable", `must refuse: ${label}`);
      assert.equal(route.distanceMeters, undefined, `must not report a distance for: ${label}`);
    } finally { stub.restore(); }
  }
});

test("a provider that never answers releases the booking request", async () => {
  const { computeGoogleRoute, MAPS_REQUEST_TIMEOUT_MS } = await maps();
  const stub = stubRoutes((_n, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  }));
  try {
    const started = Date.now();
    const route = await computeGoogleRoute(BLR, DESTINATION);
    assert.equal(route.status, "route_unavailable");
    assert.match(route.error, /did not respond within/);
    assert.ok(Date.now() - started < MAPS_REQUEST_TIMEOUT_MS + 2000, "the wait must be bounded by the adapter's own ceiling");
  } finally { stub.restore(); }
});

test("navigation links are built by encoding, not by string concatenation", async () => {
  const { mapsNavigationUrl } = await maps();
  const hostile = 'Flat 3 & 4, "Green" Villa?zoom=1#top, Bengaluru';
  const url = new URL(mapsNavigationUrl(hostile, BLR));
  assert.equal(url.origin + url.pathname, "https://www.google.com/maps/dir/");
  assert.equal(url.searchParams.get("destination"), hostile, "the address must survive a round trip intact");
  assert.equal(url.searchParams.get("origin"), `${BLR.lat},${BLR.lng}`);
  assert.equal(url.searchParams.get("travelmode"), "driving");
  assert.equal(url.hash, "", "a '#' inside the address must not become a URL fragment");
  assert.equal(url.searchParams.get("zoom"), null, "a '?' inside the address must not inject a parameter");
});
