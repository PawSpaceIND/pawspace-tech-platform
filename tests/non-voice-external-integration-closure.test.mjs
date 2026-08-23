import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const maps = await read("../lib/address-autocomplete.ts");
const readiness = await read("../app/api/integration-readiness/route.ts");
const idfy = await read("../lib/idfy-verification-client.ts");
const verification = await read("../lib/provider-verification-mandate.ts");

// Lane 2 permanent regression gate: public Maps input must fail before credentials/provider traffic.
test("reverse geocoding rejects invalid coordinates before Maps credentials/provider traffic", () => {
  assert.match(maps, /Number\.isFinite\(latitude\)/);
  assert.match(maps, /latitude>=-90&&latitude<=90/);
  assert.match(maps, /longitude>=-180&&longitude<=180/);
  const fn = maps.slice(maps.indexOf("export async function reverseGeocode"));
  assert.ok(fn.indexOf("validCoordinates(input.latitude,input.longitude)") >= 0, "coordinate guard must be present");
  assert.ok(fn.indexOf("validCoordinates(input.latitude,input.longitude)") < fn.indexOf("mapsCredentials()"), "coordinate guard must execute before credential lookup/provider path");
  assert.match(fn, /error:"Invalid coordinates"/);
});

// Credential presence is not KYC proof. The health surface must keep controlled-live false until
// callback correlation/replay and real-provider UAT have actually happened.
test("provider KYC health never turns credentials into verification evidence", () => {
  for (const key of ["IDFY_API_KEY", "IDFY_ACCOUNT_ID", "IDFY_URL"]) assert.match(readiness, new RegExp(key));
  assert.match(readiness, /integrationCode:"INT-KYC-01"/);
  assert.match(readiness, /configurationStatus:credentialStatus/);
  assert.match(readiness, /liveMode:"disabled_until_controlled_uat"/);
  assert.match(readiness, /callbackBoundary:"not_implemented"/);
  assert.match(readiness, /callbackVerificationStatus:"not_tested"/);
  assert.match(readiness, /controlledUatStatus:"not_verified"/);
  assert.match(readiness, /operationallyReady:false/);
  assert.match(readiness, /externalBoundaries:\{providerKyc:providerKycHealth\(runtime\)\}/);
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
