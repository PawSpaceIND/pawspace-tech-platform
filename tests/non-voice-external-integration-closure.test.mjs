import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { reverseGeocode } from "../lib/address-autocomplete.ts";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const readinessRoute = await read("../app/api/integration-readiness/route.ts");
const registry = await read("../lib/integration-readiness.ts");
const idfy = await read("../lib/idfy-verification-client.ts");
const verification = await read("../lib/provider-verification-mandate.ts");

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
  assert.match(registry, /codeBoundaryStatus:"partial",readinessState:"production_setup_required",credentialDetector:"idfy"/);
  for (const key of ["IDFY_API_KEY", "IDFY_ACCOUNT_ID", "IDFY_URL"]) assert.match(registry, new RegExp(key));
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
