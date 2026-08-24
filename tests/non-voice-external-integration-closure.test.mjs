import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { reverseGeocode } from "../lib/address-autocomplete.ts";

register(new URL("./helpers/ts-extension-loader.mjs", import.meta.url));
const { GET: addressAutocompleteGET } = await import("../app/api/address-autocomplete/route.ts");

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const readinessRoute = await read("../app/api/integration-readiness/route.ts");
const registry = await read("../lib/integration-readiness.ts");
const idfy = await read("../lib/idfy-verification-client.ts");
const verification = await read("../lib/provider-verification-mandate.ts");

test("reverse-geocode GET rejects missing and empty coordinates before provider traffic", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("Maps provider traffic must not be reached");
  };
  try {
    for (const query of [
      "longitude=77.59",
      "latitude=12.97",
      "latitude=&longitude=77.59",
      "latitude=12.97&longitude=",
      "latitude=%20%20&longitude=77.59",
      "latitude=12.97&longitude=%20%20",
    ]) {
      const response = await addressAutocompleteGET(new Request(`https://pawspace.test/api/address-autocomplete?mode=reverse&${query}`));
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "Valid latitude and longitude are required" });
    }
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Lane 2 permanent regression gate: invalid public Maps input must return before the
// cloudflare:workers credential import and before provider traffic.
test("reverse geocoding rejects invalid coordinates before Maps credentials/provider traffic", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("Maps provider traffic must not be reached");
  };
  try {
    for (const input of [
      { latitude: Number.NaN, longitude: 77.59 },
      { latitude: Number.POSITIVE_INFINITY, longitude: 77.59 },
      { latitude: 90.000001, longitude: 77.59 },
      { latitude: -90.000001, longitude: 77.59 },
      { latitude: 12.97, longitude: 180.000001 },
      { latitude: 12.97, longitude: -180.000001 },
    ]) {
      assert.deepEqual(await reverseGeocode(input), {
        status: "provider_error",
        error: "Invalid coordinates",
      });
    }
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// IDfy is governed by the same canonical registry, P0 launch blocker, PATCH and
// immutable audit workflow as every other required production integration.
test("provider KYC is governed through the canonical integration readiness control plane", () => {
  assert.match(registry, /code:"INT-KYC-01"/);
  assert.match(registry, /capability:"Provider KYC \/ identity verification"/);
  assert.match(registry, /priority:"P0",required:true/);
  // NOT pinned to codeBoundaryStatus:"partial" any more. That literal broke when PR #305 implemented and
  // executed the IDfy callback boundary and the code boundary legitimately became "code_ready" - the
  // assertion was protecting a spelling rather than the property it exists for. The property is that KYC
  // readiness is OPERATIONAL and cannot be moved by writing code: readiness_state stays
  // production_setup_required until an IDfy account is actually reached. That is what is asserted here,
  // and tests/lane2-readiness-handoff.test.mjs proves it by execution rather than by reading the source.
  assert.match(registry, /readinessState:"production_setup_required",credentialDetector:"idfy"/);
  assert.doesNotMatch(registry, /code:"INT-KYC-01"[^}]*readinessState:"(sandbox_verified|controlled_live_verified)"/,
    "KYC must never be seeded as verified");
  // IDFY_WEBHOOK_SECRET joins the three submission credentials: IDfy is asynchronous, so without the
  // callback secret every delivery is refused 503 and a check can only ever reach manual_review.
  for (const key of ["IDFY_API_KEY", "IDFY_ACCOUNT_ID", "IDFY_URL", "IDFY_WEBHOOK_SECRET"]) assert.match(registry, new RegExp(key));
  assert.match(registry, /case"idfy":return configured/);
  assert.match(readinessRoute, /listIntegrationReadiness\(db,runtime\)/);
  assert.match(readinessRoute, /integrationLaunchBlockers\(db\)/);
  assert.match(readinessRoute, /updateIntegrationReadiness\(db,/);
  assert.doesNotMatch(readinessRoute, /externalBoundaries|providerKycHealth/);
});

test("IDfy and provider verification remain fail-closed when external KYC is unavailable", () => {
  assert.match(idfy, /IDFY_API_KEY/);
  assert.match(idfy, /IDFY_ACCOUNT_ID/);
  assert.match(idfy, /IDFY_URL/);
  assert.match(idfy, /if \(!apiKey \|\| !accountId \|\| !url\) return \{ connected: false/);
  assert.match(verification, /if \(!idfyConfigured\(env\)\) \{ status = "pending"/);
  assert.match(verification, /allVerified: pending\.length === 0 && required\.length > 0/);
  assert.match(verification, /canTakeAssignments: pending\.length === 0 && required\.length > 0/);
});
