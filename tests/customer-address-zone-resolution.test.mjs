import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// Regression: the customer address picker must resolve the service zone from the
// canonical /api/service-zone?pincode= response, which already carries the full
// zone (id, name, description, colour, availability). It must NOT re-derive the
// zone by joining the resolved pincode against the asynchronously-loaded zone
// LIST (/api/service-zone?action=list).
//
// On a cold Worker that list could still be empty at the moment the customer
// tapped "Check". The join then returned undefined, resolveZone() bailed with
// "The resolved service zone is not enabled in this UAT build", onZoneResolved
// was never called and serviceLocation stayed null. Every Boarding host lookup
// and Sitting quote downstream then timed out at the 60s server budget:
//   - Boarding: "caregiver match did not become available"
//   - Pet Sitting: "server quote did not become available"
// ---------------------------------------------------------------------------

const clientSource = fs.readFileSync(new URL("../lib/service-zone-client.ts", import.meta.url), "utf8");
const pickerSource = fs.readFileSync(new URL("../app/mobile-app/address-picker.tsx", import.meta.url), "utf8");

const RESOLVE_BODY = {
  data: {
    zone: { zoneId: "blr-east", zoneName: "East Bengaluru", description: "Indiranagar, Whitefield, Marathahalli, Bellandur", color: "#00BCD4", serviceAvailable: true },
    assignment: { pincode: "560038", zoneId: "blr-east", city: "Bengaluru", area: "Indiranagar", cityId: "blr" },
  },
};

test("resolveServiceCoverage returns the full canonical zone without touching the zone list", async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify(RESOLVE_BODY), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const mod = await import("../lib/service-zone-client.ts");
    const coverage = await mod.resolveServiceCoverage("560038");
    assert.equal(coverage.zoneId, "blr-east");
    assert.equal(coverage.cityId, "blr");
    assert.equal(coverage.area, "Indiranagar");
    // The full zone the picker needs to render its resolved card, straight from resolve:
    assert.equal(coverage.zone.zoneId, "blr-east");
    assert.equal(coverage.zone.zoneName, "East Bengaluru");
    assert.equal(coverage.zone.description, "Indiranagar, Whitefield, Marathahalli, Bellandur");
    assert.equal(coverage.zone.color, "#00BCD4");
    assert.equal(coverage.zone.serviceAvailable, true);
    // Resolution must depend ONLY on the per-pincode endpoint, never the async list.
    assert.ok(calls.length >= 1, "resolve endpoint was called");
    assert.ok(calls.every((u) => !u.includes("action=list")), `resolution must not consult the zone list endpoint, saw: ${calls.join(", ")}`);
    assert.ok(calls.some((u) => u.includes("pincode=560038")), "resolve endpoint was queried by pincode");
  } finally {
    globalThis.fetch = original;
  }
});

test("resolveServiceCoverage still rejects a pincode outside the enabled service area", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "PIN code 999999 is outside the currently enabled service area." }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const mod = await import("../lib/service-zone-client.ts");
    await assert.rejects(() => mod.resolveServiceCoverage("999999"), /outside the currently enabled service area/);
  } finally {
    globalThis.fetch = original;
  }
});

test("service-zone client contract carries the full resolved zone through to callers", () => {
  assert.match(clientSource, /export type ResolvedServiceZone/);
  assert.match(clientSource, /zone:\s*ResolvedServiceZone/);
  // The resolved zone must expose the display fields the picker card needs.
  assert.match(clientSource, /description:\s*string/);
  assert.match(clientSource, /color:\s*string/);
  assert.match(clientSource, /serviceAvailable:\s*boolean/);
});

test("address picker resolves service location from the canonical coverage, not the async zone list", () => {
  // Uses the zone carried by the resolve response.
  assert.match(pickerSource, /coverage\.zone\.zoneId/);
  // Must NOT gate resolution on a client-side join against the async list, and must
  // not surface the old race-only error string on the resolution path.
  assert.doesNotMatch(pickerSource, /zones\.find\(item=>item\.zoneId===coverage\.zoneId\)/);
  assert.doesNotMatch(pickerSource, /The resolved service zone is not enabled in this UAT build/);
  // The informational "Configured UAT service zones" list stays list-driven for display.
  assert.match(pickerSource, /Configured UAT service zones/);
});
