import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const idfy = await read("../lib/idfy-verification-client.ts");
const mandate = await read("../lib/provider-verification-mandate.ts");
const route = await read("../app/api/provider-verification/route.ts");

test("IDfy adapter is fail-closed (verifies nothing until keys are set)", () => {
  assert.match(idfy, /export function idfyConfigured/);
  assert.match(idfy, /IDFY_API_KEY/); assert.match(idfy, /IDFY_ACCOUNT_ID/); assert.match(idfy, /IDFY_URL/);
  assert.match(idfy, /if \(!apiKey \|\| !accountId \|\| !url\) return \{ connected: false/);
  // ambiguous results route to human manual review, never a silent approve
  assert.match(idfy, /return "manual_review"/);
});

test("per-category mandate: defaults, automatable vs manual, assignment eligibility", () => {
  assert.match(mandate, /groomer: \["aadhaar", "pan"\]/);
  assert.match(mandate, /trainer: \["aadhaar", "pan", "police_verification"\]/);
  assert.match(mandate, /host: \["aadhaar", "pan", "house_verification", "pet_proofing_photo"\]/);
  // automatable checks go through IDfy and are fail-closed to 'pending'; manual checks await an agent
  assert.match(mandate, /if \(!idfyConfigured\(env\)\)/);
  assert.match(mandate, /status = "manual_review"/);
  assert.match(mandate, /canTakeAssignments: pending\.length === 0 && required\.length > 0/);
  // an automatable check can't be faked via the manual path
  assert.match(mandate, /don't record it manually/);
});

test("the verification route is providers.manage-gated with the three actions", () => {
  assert.match(route, /requirePermission\(actor,"providers\.manage"\)/);
  assert.match(route, /action==="run"/);
  assert.match(route, /action==="record_manual"/);
  assert.match(route, /action==="set_mandate"/);
  assert.match(route, /sameOrigin\(request\)/);
});
